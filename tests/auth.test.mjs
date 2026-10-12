import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { handleAuth } from "../server/auth.mjs";
import { getPool } from "../server/database.mjs";
import { createApiServer } from "../server/index.mjs";

class FakePool {
  users = [];
  sessions = [];
  async connect() { return { query: (...args) => this.query(...args), release() {} }; }
  async query(sql, values = []) {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT id, name, email, password_hash")) return { rows: this.users.filter((user) => user.email === values[0]).map((user) => ({ ...user })), rowCount: this.users.filter((user) => user.email === values[0]).length };
    if (sql.includes("FROM sessions s JOIN users u")) {
      const session = this.sessions.find((item) => item.token_hash === values[0] && item.expires_at > new Date());
      const user = this.users.find((item) => item.id === session?.user_id && item.status === "active");
      return { rows: user ? [{ ...user, csrf_hash: session.csrf_hash }] : [], rowCount: user ? 1 : 0 };
    }
    if (sql.startsWith("INSERT INTO sessions")) { this.sessions.push({ token_hash: values[0], user_id: values[1], csrf_hash: values[2], expires_at: new Date(values[3]) }); return { rows: [], rowCount: 1 }; }
    if (sql.startsWith("UPDATE sessions SET csrf_hash")) { const row = this.sessions.find((item) => item.token_hash === values[1]); if (row) row.csrf_hash = values[0]; return { rows: [], rowCount: row ? 1 : 0 }; }
    if (sql.startsWith("DELETE FROM sessions WHERE user_id")) { this.sessions = this.sessions.filter((item) => item.user_id !== values[0]); return { rows: [], rowCount: 1 }; }
    if (sql.startsWith("UPDATE teachers SET user_id=NULL")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("DELETE FROM student_profiles")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("DELETE FROM sessions")) { this.sessions = this.sessions.filter((item) => item.token_hash !== values[0]); return { rows: [], rowCount: 1 }; }
    if (sql.startsWith("INSERT INTO users")) {
      if (this.users.some((item) => item.email === values[2])) { const error = new Error("duplicate"); error.code = "23505"; throw error; }
      const user = { id: values[0], name: values[1], email: values[2], password_hash: values[3], role: values[4], status: "active", created_at: new Date() };
      this.users.push(user); return { rows: [{ ...user }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE users SET role")) {
      const user = this.users.find((item) => item.id === values[1]); if (!user) return { rows: [], rowCount: 0 };
      user.role = values[0]; user.updated_at = new Date(); return { rows: [{ ...user }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT id,name,email,role,status,created_at FROM users")) return { rows: this.users.map(({ password_hash, ...user }) => user), rowCount: this.users.length };
    if (/FROM (batches|subjects|teachers|rooms|batch_requirements|teacher_subjects|batch_availability)/.test(sql)) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT count(*)::int AS count FROM users")) return { rows: [{ count: this.users.filter((user) => user.role === "Admin" && user.status === "active").length }], rowCount: 1 };
    if (sql.startsWith("SELECT role,status FROM users WHERE id")) { const user = this.users.find((item) => item.id === values[0]); return { rows: user ? [{ role: user.role, status: user.status }] : [], rowCount: user ? 1 : 0 }; }
    throw new Error(`Unexpected test query: ${sql}`);
  }
}

async function fixture(pool = new FakePool()) {
  const server = createServer((req, res) => { void handleAuth(req, res, pool); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options = {}) => fetch(`${base}${path}`, { ...options, headers: { origin: base, ...(options.headers || {}) } });
  request.base = base;
  return { pool, request, close: () => new Promise((resolve) => server.close(resolve)) };
}
const json = (value) => ({ "content-type": "application/json", body: JSON.stringify(value) });
const cookieOf = (response) => response.headers.get("set-cookie").split(";")[0];

test("HTTP auth boundary disables public signup and rejects invalid credentials generically", async () => {
  const originalSignupSetting = process.env.AUTH_ALLOW_SIGNUP;
  delete process.env.AUTH_ALLOW_SIGNUP;
  const app = await fixture();
  try {
    const created = await app.request("/api/auth/signup", { method: "POST", ...json({ name: "Student", email: "Student@Example.com", password: "correct horse battery" }) });
    assert.equal(created.status, 403, "public student signup is closed by default");
    app.pool.users.push({ id: randomUUID(), name: "Student", email: "student@example.com", password_hash: await bcrypt.hash("correct horse battery", 4), role: "Student", status: "active", created_at: new Date() });
    process.env.AUTH_ALLOW_SIGNUP = "true";
    const stillDisabled = await app.request("/api/auth/signup", { method: "POST", ...json({ name: "Attacker", email: "attacker@example.com", password: "correct horse battery" }) });
    assert.equal(stillDisabled.status, 403, "public signup cannot create unlinked identities");
    const bad = await app.request("/api/auth/login", { method: "POST", ...json({ email: "student@example.com", password: "wrong password" }) });
    assert.equal(bad.status, 401);
    assert.deepEqual(await bad.json(), { error: "Invalid email or password." });
    const login = await app.request("/api/auth/login", { method: "POST", ...json({ email: "STUDENT@example.com", password: "correct horse battery" }) });
    assert.equal(login.status, 200);
    assert.equal(app.pool.sessions.length, 1);
    const session = await app.request("/api/auth/session", { headers: { cookie: cookieOf(login) } });
    assert.equal(session.status, 200);
    const rotatedCsrf = (await session.json()).csrfToken;
    const forgedCookie = await app.request("/api/auth/session", { headers: { cookie: "schedulify_session=forged" } });
    assert.equal(forgedCookie.status, 401);
    const logout = await app.request("/api/auth/logout", { method: "POST", headers: { cookie: cookieOf(login), "x-csrf-token": rotatedCsrf } });
    assert.equal(logout.status, 200);
    assert.equal(app.pool.sessions.length, 0);
    const revoked = await app.request("/api/auth/session", { headers: { cookie: cookieOf(login) } });
    assert.equal(revoked.status, 401);
  } finally {
    if (originalSignupSetting === undefined) delete process.env.AUTH_ALLOW_SIGNUP;
    else process.env.AUTH_ALLOW_SIGNUP = originalSignupSetting;
    await app.close();
  }
});

test("HTTP role checks deny student provisioning, require CSRF, and permit administrator provisioning", async () => {
  const pool = new FakePool();
  pool.users.push({ id: randomUUID(), name: "Student", email: "s@example.com", password_hash: await bcrypt.hash("correct horse battery", 4), role: "Student", status: "active", created_at: new Date() });
  pool.users.push({ id: randomUUID(), name: "Administrator", email: "a@example.com", password_hash: await bcrypt.hash("correct horse battery", 4), role: "Admin", status: "active", created_at: new Date() });
  const app = await fixture(pool);
  try {
    const loginStudent = await app.request("/api/auth/login", { method: "POST", ...json({ email: "s@example.com", password: "correct horse battery" }) });
    const student = await loginStudent.json();
    const studentCookie = cookieOf(loginStudent);
    const denied = await app.request("/api/auth/users", { method: "POST", headers: { cookie: studentCookie, "x-csrf-token": student.csrfToken }, ...json({ name: "Other", email: "o@example.com", password: "correct horse battery", role: "Admin" }) });
    assert.equal(denied.status, 403);
    const roleDenied = await app.request(`/api/auth/users/${pool.users[1].id}/role`, { method: "PATCH", headers: { cookie: studentCookie, "x-csrf-token": student.csrfToken }, ...json({ role: "Admin" }) });
    assert.equal(roleDenied.status, 403);
    const loginAdmin = await app.request("/api/auth/login", { method: "POST", ...json({ email: "a@example.com", password: "correct horse battery" }) });
    const admin = await loginAdmin.json();
    const adminCookie = cookieOf(loginAdmin);
    const noCsrf = await app.request("/api/auth/users", { method: "POST", headers: { cookie: adminCookie }, ...json({ name: "HOD", email: "h@example.com", password: "correct horse battery", role: "HOD" }) });
    assert.equal(noCsrf.status, 403);
    const provisioned = await app.request("/api/auth/users", { method: "POST", headers: { cookie: adminCookie, "x-csrf-token": admin.csrfToken }, ...json({ name: "HOD", email: "h@example.com", password: "correct horse battery", role: "HOD" }) });
    assert.equal(provisioned.status, 201);
    assert.equal((await provisioned.json()).user.role, "HOD");
    const selfDemotion = await app.request(`/api/auth/users/${pool.users[1].id}/role`, { method: "PATCH", headers: { cookie: adminCookie, "x-csrf-token": admin.csrfToken }, ...json({ role: "HOD" }) });
    assert.equal(selfDemotion.status, 409);
    const otherRoleChange = await app.request(`/api/auth/users/${pool.users[0].id}/role`, { method: "PATCH", headers: { cookie: adminCookie, "x-csrf-token": admin.csrfToken }, ...json({ role: "Teacher" }) });
    assert.equal(otherRoleChange.status, 200);
    assert.equal(pool.users[0].role, "Teacher");
  } finally { await app.close(); }
});

test("expired sessions and cross-origin state changes are rejected", async () => {
  const pool = new FakePool();
  pool.users.push({ id: randomUUID(), name: "Student", email: "s@example.com", password_hash: await bcrypt.hash("correct horse battery", 4), role: "Student", status: "active", created_at: new Date() });
  const app = await fixture(pool);
  try {
    const login = await app.request("/api/auth/login", { method: "POST", ...json({ email: "s@example.com", password: "correct horse battery" }) });
    const { csrfToken } = await login.json();
    pool.sessions[0].expires_at = new Date(Date.now() - 1000);
    const expired = await app.request("/api/auth/session", { headers: { cookie: cookieOf(login) } });
    assert.equal(expired.status, 401);
    const crossOrigin = await app.request("/api/auth/logout", { method: "POST", headers: { origin: "https://evil.example", cookie: cookieOf(login), "x-csrf-token": csrfToken }, ...json({}) });
    assert.equal(crossOrigin.status, 403);
    assert.ok(csrfToken);
  } finally { await app.close(); }
});

test("missing database configuration fails without an in-memory fallback", () => {
  const configured = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try { assert.throws(() => getPool(), /DATABASE_URL is required/); }
  finally { if (configured !== undefined) process.env.DATABASE_URL = configured; }
});

test("Copilot HTTP endpoint requires an Admin session and CSRF token", async () => {
  const pool = new FakePool();
  for (const role of ["Student", "Teacher", "HOD", "Admin"]) {
    pool.users.push({ id: randomUUID(), name: role, email: `${role.toLowerCase()}@example.com`, password_hash: await bcrypt.hash("correct horse battery", 4), role, status: "active", created_at: new Date() });
  }
  const server = createApiServer({ poolProvider: () => pool, interpret: async () => ({ status: 200, body: { rules: [] } }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, options = {}) => fetch(`${base}${path}`, { ...options, headers: { origin: base, ...(options.headers || {}) } });
  const bodyInput = { request: "Prefer math in the morning" };
  try {
    assert.equal((await call("/api/copilot/interpret", { method: "POST", ...json(bodyInput) })).status, 401);
    for (const role of ["Student", "Teacher", "HOD"]) {
      const login = await call("/api/auth/login", { method: "POST", ...json({ email: `${role.toLowerCase()}@example.com`, password: "correct horse battery" }) });
      const response = await call("/api/copilot/interpret", { method: "POST", headers: { cookie: cookieOf(login), "x-csrf-token": (await login.json()).csrfToken }, ...json(bodyInput) });
      assert.equal(response.status, 403, `${role} must be denied by the server`);
    }
    const login = await call("/api/auth/login", { method: "POST", ...json({ email: "admin@example.com", password: "correct horse battery" }) });
    const admin = await login.json();
    const noCsrf = await call("/api/copilot/interpret", { method: "POST", headers: { cookie: cookieOf(login) }, ...json(bodyInput) });
    assert.equal(noCsrf.status, 403);
    const allowed = await call("/api/copilot/interpret", { method: "POST", headers: { cookie: cookieOf(login), "x-csrf-token": admin.csrfToken }, ...json(bodyInput) });
    assert.equal(allowed.status, 200);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("login throttles repeated attempts and database failures fail closed", async () => {
  const app = await fixture();
  try {
    const responses = await Promise.all(Array.from({ length: 11 }, () => app.request("/api/auth/login", { method: "POST", ...json({}) })));
    assert.ok(responses.some((response) => response.status === 429));
  } finally { await app.close(); }
  const brokenPool = new FakePool();
  brokenPool.query = async () => { throw new Error("database secret details"); };
  const broken = await fixture(brokenPool);
  try {
    const response = await broken.request("/api/auth/session", { headers: { cookie: "schedulify_session=forged" } });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Authentication service is temporarily unavailable." });
  } finally { await broken.close(); }
});
