import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { interpretRequest } from "./provider.mjs";
import { getPool } from "./database.mjs";
import { authenticateRequest, handleAuth, hasPermission, verifyCsrf } from "./auth.mjs";
import { approveTimetable, generateCandidate, listTimetables, readDomain, readOwnPublishedTimetable, readRevision, readRules, readTimetable, rejectTimetable, replaceRules, saveDomain, SchedulingError } from "./scheduling.mjs";

const PORT = Number(process.env.API_PORT || 3001);
const HOST = process.env.API_HOST || "0.0.0.0";
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 12;
const buckets = new Map();

function send(res, status, data) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

function rateLimited(req) {
  const now = Date.now();
  const ip = req.socket.remoteAddress || "unknown";
  const bucket = buckets.get(ip);
  if (!bucket || now - bucket.start > WINDOW_MS) {
    buckets.set(ip, { start: now, count: 1 });
    if (buckets.size > 1000) for (const [key, item] of buckets) if (now - item.start > WINDOW_MS) buckets.delete(key);
    return false;
  }
  bucket.count += 1;
  return bucket.count > MAX_REQUESTS;
}

async function parseBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 2_000_000) throw new Error("too_large");
  }
  return body.trim() ? JSON.parse(body) : {};
}

export function createApiServer({ poolProvider = getPool, interpret = interpretRequest } = {}) {
  return createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.url?.startsWith("/api/auth/")) {
    try { return await handleAuth(req, res, poolProvider()); }
    catch (error) { return send(res, 503, { error: "Authentication service is unavailable." }); }
  }
  if (url.pathname === "/api/health/live" && req.method === "GET") {
    return send(res, 200, { ok: true });
  }
  if (["/api/health", "/api/health/ready"].includes(url.pathname) && req.method === "GET") {
    try { await poolProvider().query("SELECT 1"); return send(res, 200, { ok: true, checks: { postgres: "available" } }); }
    catch { return send(res, 503, { ok: false, checks: { postgres: "unavailable" } }); }
  }
  let session;
  try { session = await authenticateRequest(req, poolProvider()); }
  catch { return send(res, 503, { error: "Authentication service is temporarily unavailable." }); }
  if (!session) return send(res, 401, { error: "Authentication required." });
  const pool = poolProvider();
  const requireRole = (roles) => roles.includes(session.user.role);
  const changing = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
  if (changing && !verifyCsrf(req, session.csrfHash)) return send(res, 403, { error: "Invalid request token." });
  let input = {};
  if (changing) { try { input = await parseBody(req); } catch (error) { return send(res, error.message === "too_large" ? 413 : 400, { error: error.message === "too_large" ? "Request is too large." : "Invalid JSON request." }); } }
  try {
    if (url.pathname === "/api/domain" && req.method === "GET") {
      if (!requireRole(["Admin", "HOD"])) return send(res, 403, { error: "Forbidden." });
      const [revision, domain, rules] = await Promise.all([readRevision(pool), readDomain(pool), readRules(pool)]);
      return send(res, 200, { revision, domain, rules });
    }
    if (url.pathname === "/api/domain" && req.method === "PUT") {
      if (!requireRole(["Admin"])) return send(res, 403, { error: "Forbidden." });
      return send(res, 200, await saveDomain(pool, input, session.user.id));
    }
    if (url.pathname === "/api/constraints" && req.method === "PUT") {
      if (!requireRole(["Admin"])) return send(res, 403, { error: "Forbidden." });
      return send(res, 200, await replaceRules(pool, input, session.user.id));
    }
    if (url.pathname === "/api/timetables/generate" && req.method === "POST") {
      if (!requireRole(["Admin"])) return send(res, 403, { error: "Forbidden." });
      const maxNodes = Math.min(25_000, Math.max(1, Number(input.maxNodes) || 25_000));
      const maxDurationMs = Math.min(10_000, Math.max(100, Number(input.maxDurationMs) || 10_000));
      const result = await generateCandidate(pool, session.user.id, { maxNodes, maxDurationMs });
      return send(res, result.ok ? 201 : 422, result);
    }
    if (url.pathname === "/api/timetables" && req.method === "GET") {
      if (!requireRole(["Admin", "HOD"])) return send(res, 403, { error: "Forbidden." });
      return send(res, 200, { versions: await listTimetables(pool) });
    }
    if (url.pathname === "/api/timetable/mine" && req.method === "GET") {
      if (!requireRole(["Teacher", "Student"])) return send(res, 403, { error: "Forbidden." });
      return send(res, 200, await readOwnPublishedTimetable(pool, session.user));
    }
    const versionMatch = url.pathname.match(/^\/api\/timetables\/([0-9a-f-]+)$/i);
    if (versionMatch && req.method === "GET") {
      if (!requireRole(["Admin", "HOD"])) return send(res, 403, { error: "Forbidden." });
      const timetable = await readTimetable(pool, versionMatch[1]);
      return send(res, timetable ? 200 : 404, timetable || { error: "Timetable version not found." });
    }
    const actionMatch = url.pathname.match(/^\/api\/timetables\/([0-9a-f-]+)\/(approve|reject)$/i);
    if (actionMatch && req.method === "POST") {
      if (!requireRole(["HOD"])) return send(res, 403, { error: "Forbidden." });
      if (Object.keys(input).length) return send(res, 400, { error: "This action does not accept client-supplied timetable data." });
      const result = actionMatch[2] === "approve" ? await approveTimetable(pool, actionMatch[1], session.user.id) : await rejectTimetable(pool, actionMatch[1], session.user.id);
      return send(res, 200, result);
    }
    if (url.pathname === "/api/copilot/interpret" && req.method === "POST") {
      if (!hasPermission(session.user.role, "copilot:interpret")) return send(res, 403, { error: "Forbidden." });
      if (rateLimited(req)) return send(res, 429, { error: "Too many requests. Please try again in a minute." });
      const shape = z.object({ request: z.string().trim().min(5).max(1000) }).strict().safeParse(input);
      if (!shape.success) return send(res, 400, { error: "Provide a scheduling request." });
      const domain = await readDomain(pool);
      const result = await interpret({ request: shape.data.request, catalog: { teachers: domain.teachers.map((item) => item.name), subjects: domain.subjects.map((item) => item.name), rooms: domain.rooms.map((item) => item.name), batches: domain.batches.map((item) => item.name) } });
      return send(res, result.status, result.body);
    }
    return send(res, 404, { error: "Not found" });
  } catch (error) {
    if (error instanceof SchedulingError) return send(res, error.status, { error: error.message, code: error.code, ...(error.details || {}) });
    if (error.code === "23505" || error.code === "23503" || error.code === "23514") return send(res, 409, { error: "The change conflicts with existing scheduling data or references." });
    console.error("Scheduling API request failed:", error.code || "internal_error");
    return send(res, 503, { error: "The scheduling service is temporarily unavailable." });
  }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required to start the API.");
    process.exitCode = 1;
  } else if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    console.error("API_PORT must be an integer between 1 and 65535.");
    process.exitCode = 1;
  } else if (process.env.NODE_ENV === "production" && (process.env.COOKIE_SECURE !== "true" || !process.env.PUBLIC_APP_ORIGIN?.startsWith("https://"))) {
    console.error("Production requires COOKIE_SECURE=true and an HTTPS PUBLIC_APP_ORIGIN.");
    process.exitCode = 1;
  } else {
    const server = createApiServer();
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    server.keepAliveTimeout = 5_000;
    let shuttingDown = false;
    const shutdown = async (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`Received ${signal}; shutting down.`);
      const forceExit = setTimeout(() => { console.error("Graceful shutdown timed out."); process.exit(1); }, 15_000);
      forceExit.unref();
      server.close(async (error) => {
        try { const { closePool } = await import("./database.mjs"); await closePool(); }
        catch { process.exitCode = 1; }
        if (error) process.exitCode = 1;
        clearTimeout(forceExit);
      });
      server.closeIdleConnections?.();
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    server.listen(PORT, HOST, () => console.log(`Schedulify API listening on ${HOST}:${PORT}`));
  }
}
