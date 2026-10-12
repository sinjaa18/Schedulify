import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";

const COOKIE = "schedulify_session";
const SESSION_MS = 12 * 60 * 60 * 1000;
const DUMMY_PASSWORD_HASH = "$2b$12$EObfycDyk3eBvOVCXKYEce4HFLs0M8xcLJpOUBvOGOrRZKbup5nNy";
const permissions = Object.freeze({
  Admin: new Set(["copilot:interpret", "users:provision", "users:role-change"]),
  HOD: new Set(["timetable:approve"]),
  Teacher: new Set(["timetable:view-own"]),
  Student: new Set(["timetable:view-batch"]),
});
export const hasPermission = (role, permission) => permissions[role]?.has(permission) ?? false;
export const normalizeEmail = (email) => email.trim().toLowerCase();
const digest = (value) => createHash("sha256").update(value).digest("hex");
const publicUser = ({ id, name, email, role, status, created_at }) => ({ id, name, email, role, status, createdAt: created_at });

const accountSchema = z.object({ name: z.string().trim().min(1).max(100), email: z.string().trim().email().max(254), password: z.string().min(12).max(72).refine((value) => Buffer.byteLength(value, "utf8") <= 72) }).strict();
const provisionSchema = accountSchema.extend({ role: z.enum(["Admin", "HOD", "Teacher", "Student"]) }).strict();

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}
async function body(req) {
  let value = "";
  for await (const part of req) { value += part; if (Buffer.byteLength(value) > 16_000) throw new Error("too_large"); }
  return JSON.parse(value);
}
function secureCookie(req) {
  return process.env.COOKIE_SECURE === "true" || (process.env.NODE_ENV === "production" && req.socket.encrypted);
}
function cookieHeader(req, value, maxAge = SESSION_MS / 1000) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookie(req) ? "; Secure" : ""}`;
}
function sessionCookie(req) {
  const header = req.headers.cookie || "";
  const match = header.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${COOKIE}=`));
  return match?.slice(COOKIE.length + 1) || null;
}
function expectedOrigin(req) {
  if (process.env.PUBLIC_APP_ORIGIN) return process.env.PUBLIC_APP_ORIGIN.replace(/\/$/, "");
  const proto = req.socket.encrypted ? "https" : "http";
  return `${proto}://${req.headers.host}`;
}
function originAllowed(req) { return req.headers.origin === expectedOrigin(req); }
function csrfAllowed(req, csrfHash) { return originAllowed(req) && typeof req.headers["x-csrf-token"] === "string" && digest(req.headers["x-csrf-token"]) === csrfHash; }

async function currentSession(req, pool) {
  const token = sessionCookie(req);
  if (!token) return null;
  const result = await pool.query(`SELECT s.csrf_hash, u.id, u.name, u.email, u.role, u.status, u.created_at
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at > now()`, [digest(token)]);
  if (!result.rowCount || result.rows[0].status !== "active") return null;
  return { user: result.rows[0], csrfHash: result.rows[0].csrf_hash };
}
export const authenticateRequest = currentSession;
export const verifyCsrf = csrfAllowed;

const loginBuckets = new Map();
function limited(req) {
  const key = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const entry = loginBuckets.get(key);
  if (loginBuckets.size > 2000) for (const [address, item] of loginBuckets) if (now - item.started > 60_000) loginBuckets.delete(address);
  if (!entry || now - entry.started > 60_000) { loginBuckets.set(key, { started: now, count: 1 }); return false; }
  entry.count += 1;
  return entry.count > 10;
}

export async function handleAuth(req, res, pool) {
  const path = new URL(req.url, "http://localhost").pathname;
  if (!path.startsWith("/api/auth/")) return false;
  const method = req.method;
  if (["POST", "PATCH", "DELETE"].includes(method) && !originAllowed(req)) { send(res, 403, { error: "Request origin is not allowed." }); return true; }

  try {
    if (method === "POST" && path === "/api/auth/login") {
      if (limited(req)) { send(res, 429, { error: "Too many attempts. Try again later." }); return true; }
      const parsed = z.object({ email: z.string().max(254), password: z.string().max(72).refine((value) => Buffer.byteLength(value, "utf8") <= 72) }).strict().safeParse(await body(req));
      if (!parsed.success) { send(res, 400, { error: "Invalid credentials." }); return true; }
      const result = await pool.query("SELECT id, name, email, password_hash, role, status, created_at FROM users WHERE email=$1", [normalizeEmail(parsed.data.email)]);
      const user = result.rows[0];
      const matches = await bcrypt.compare(parsed.data.password, user?.password_hash || DUMMY_PASSWORD_HASH);
      if (!user || user.status !== "active" || !matches) { send(res, 401, { error: "Invalid email or password." }); return true; }
      const token = randomBytes(32).toString("base64url");
      const csrfToken = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + SESSION_MS);
      await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_hash,expires_at) VALUES($1,$2,$3,$4)", [digest(token), user.id, digest(csrfToken), expiresAt]);
      send(res, 200, { user: publicUser(user), csrfToken }, { "set-cookie": cookieHeader(req, token) });
      return true;
    }
    if (method === "POST" && path === "/api/auth/signup") {
      send(res, 403, { error: "Account registration is disabled. Contact an administrator." });
      return true;
    }
    if (method === "GET" && path === "/api/auth/session") {
      const session = await currentSession(req, pool);
      if (!session) { send(res, 401, { error: "Authentication required." }, { "set-cookie": cookieHeader(req, "", 0) }); return true; }
      const csrfToken = req.headers["x-csrf-token"];
      let token = csrfToken;
      if (typeof token !== "string" || digest(token) !== session.csrfHash) {
        // The synchronizer token is generated per session and stored as a hash.
        // Rotation is explicit through the authenticated session response.
        token = randomBytes(32).toString("base64url");
        await pool.query("UPDATE sessions SET csrf_hash=$1 WHERE token_hash=$2", [digest(token), digest(sessionCookie(req))]);
      }
      send(res, 200, { user: publicUser(session.user), csrfToken: token });
      return true;
    }
    if (method === "POST" && path === "/api/auth/logout") {
      const session = await currentSession(req, pool);
      if (!session || !csrfAllowed(req, session.csrfHash)) { send(res, session ? 403 : 401, { error: session ? "Invalid request token." : "Authentication required." }); return true; }
      await pool.query("DELETE FROM sessions WHERE token_hash=$1", [digest(sessionCookie(req))]);
      send(res, 200, { ok: true }, { "set-cookie": cookieHeader(req, "", 0) });
      return true;
    }
    if (method === "POST" && path === "/api/auth/users") {
      const session = await currentSession(req, pool);
      if (!session) { send(res, 401, { error: "Authentication required." }); return true; }
      if (!hasPermission(session.user.role, "users:provision")) { send(res, 403, { error: "Forbidden." }); return true; }
      if (!csrfAllowed(req, session.csrfHash)) { send(res, 403, { error: "Invalid request token." }); return true; }
      const parsed = provisionSchema.safeParse(await body(req));
      if (!parsed.success) { send(res, 400, { error: "Invalid account details." }); return true; }
      const user = await createAccount(pool, parsed.data, parsed.data.role);
      send(res, 201, { user });
      return true;
    }
    if (method === "GET" && path === "/api/auth/users") {
      const session = await currentSession(req, pool);
      if (!session) { send(res, 401, { error: "Authentication required." }); return true; }
      if (!hasPermission(session.user.role, "users:provision")) { send(res, 403, { error: "Forbidden." }); return true; }
      const result = await pool.query(`SELECT u.id,u.name,u.email,u.role,u.status,u.created_at,t.id AS teacher_id,p.batch_id AS student_batch_id
        FROM users u LEFT JOIN teachers t ON t.user_id=u.id LEFT JOIN student_profiles p ON p.user_id=u.id ORDER BY u.created_at DESC LIMIT 500`);
      send(res, 200, { users: result.rows.map((row) => ({ ...publicUser(row), teacherId: row.teacher_id, batchId: row.student_batch_id })) });
      return true;
    }
    if (method === "PATCH" && /^\/api\/auth\/users\/[0-9a-f-]+\/association$/.test(path)) {
      const session = await currentSession(req, pool);
      if (!session) { send(res, 401, { error: "Authentication required." }); return true; }
      if (!hasPermission(session.user.role, "users:provision")) { send(res, 403, { error: "Forbidden." }); return true; }
      if (!csrfAllowed(req, session.csrfHash)) { send(res, 403, { error: "Invalid request token." }); return true; }
      const parsed = z.object({ teacherId: z.string().min(1).max(128).nullable().optional(), batchId: z.string().min(1).max(128).nullable().optional() }).strict().safeParse(await body(req));
      if (!parsed.success || (parsed.data.teacherId != null && parsed.data.batchId != null)) { send(res, 400, { error: "Provide one teacher or student association." }); return true; }
      const id = path.split("/")[4]; const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const account = await client.query("SELECT role FROM users WHERE id=$1 FOR UPDATE", [id]);
        if (!account.rowCount) { await client.query("ROLLBACK"); send(res, 404, { error: "Account not found." }); return true; }
        const role = account.rows[0].role; const { teacherId, batchId } = parsed.data;
        if ((role === "Teacher" && (!teacherId || batchId)) || (role === "Student" && (!batchId || teacherId)) || (!["Teacher", "Student"].includes(role) && (teacherId || batchId))) {
          await client.query("ROLLBACK"); send(res, 409, { error: "The association must match the account role." }); return true;
        }
        if (role === "Teacher") {
          await client.query("UPDATE teachers SET user_id=NULL WHERE user_id=$1", [id]);
          const linked = await client.query("UPDATE teachers SET user_id=$1 WHERE id=$2 AND (user_id IS NULL OR user_id=$1) RETURNING id", [id, teacherId]);
          if (!linked.rowCount) { await client.query("ROLLBACK"); send(res, 409, { error: "Teacher record not found or already linked." }); return true; }
        } else if (role === "Student") {
          const linked = await client.query(`INSERT INTO student_profiles(user_id,batch_id) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET batch_id=EXCLUDED.batch_id RETURNING user_id`, [id, batchId]);
        }
        await client.query("DELETE FROM sessions WHERE user_id=$1", [id]); await client.query("COMMIT");
        send(res, 200, { ok: true });
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
      return true;
    }
    if (method === "PATCH" && /^\/api\/auth\/users\/[0-9a-f-]+\/role$/.test(path)) {
      const session = await currentSession(req, pool);
      if (!session) { send(res, 401, { error: "Authentication required." }); return true; }
      if (!hasPermission(session.user.role, "users:role-change")) { send(res, 403, { error: "Forbidden." }); return true; }
      if (!csrfAllowed(req, session.csrfHash)) { send(res, 403, { error: "Invalid request token." }); return true; }
      const parsed = z.object({ role: z.enum(["Admin", "HOD", "Teacher", "Student"]) }).strict().safeParse(await body(req));
      if (!parsed.success) { send(res, 400, { error: "Invalid role." }); return true; }
      const id = path.split("/")[4];
      if (id === session.user.id && parsed.data.role !== "Admin") { send(res, 409, { error: "You cannot remove your own administrator role." }); return true; }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(74190512)");
        const admins = await client.query("SELECT count(*)::int AS count FROM users WHERE role='Admin' AND status='active'");
        const target = await client.query("SELECT role,status FROM users WHERE id=$1 FOR UPDATE", [id]);
        if (!target.rowCount) { await client.query("ROLLBACK"); send(res, 404, { error: "Account not found." }); return true; }
        if (target.rows[0].role === "Admin" && target.rows[0].status === "active" && admins.rows[0].count <= 1 && parsed.data.role !== "Admin") {
          await client.query("ROLLBACK"); send(res, 409, { error: "At least one active administrator must remain." }); return true;
        }
        await client.query("UPDATE teachers SET user_id=NULL WHERE user_id=$1", [id]);
        await client.query("DELETE FROM student_profiles WHERE user_id=$1", [id]);
        const result = await client.query("UPDATE users SET role=$1,updated_at=now() WHERE id=$2 RETURNING id,name,email,role,status,created_at", [parsed.data.role, id]);
        await client.query("DELETE FROM sessions WHERE user_id=$1", [id]);
        await client.query("COMMIT");
        send(res, 200, { user: publicUser(result.rows[0]) });
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
      return true;
    }
    send(res, 404, { error: "Not found." });
  } catch (error) {
    if (error.message === "too_large") send(res, 413, { error: "Request is too large." });
    else if (error instanceof SyntaxError) send(res, 400, { error: "Invalid JSON request." });
    else if (error.code === "23505") send(res, 409, { error: path.endsWith("/association") ? "That teacher record is already linked to another account." : "An account with that email already exists." });
    else if (error.code === "23503") send(res, 409, { error: "The selected scheduling record no longer exists." });
    else { console.error("Authentication request failed:", error.code || "internal_error"); send(res, 503, { error: "Authentication service is temporarily unavailable." }); }
  }
  return true;
}

export async function createAccount(pool, input, role) {
  const passwordHash = await bcrypt.hash(input.password, 12);
  const normalized = normalizeEmail(input.email);
  const result = await pool.query(`INSERT INTO users(id,name,email,password_hash,role)
    VALUES($1,$2,$3,$4,$5) RETURNING id,name,email,role,status,created_at`, [randomUUID(), input.name.trim(), normalized, passwordHash, role]);
  return publicUser(result.rows[0]);
}

export async function provisionInitialAdmin(pool, input) {
  input = accountSchema.parse(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(74190512)");
    const admins = await client.query("SELECT 1 FROM users WHERE role='Admin' LIMIT 1");
    if (admins.rowCount) throw new Error("An administrator already exists.");
    const created = await createAccount(client, input, "Admin");
    await client.query("COMMIT");
    return created;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
