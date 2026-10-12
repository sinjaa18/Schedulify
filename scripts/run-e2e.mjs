import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import bcrypt from "bcryptjs";
import { runMigrations } from "../server/migrate.mjs";
import { createApiServer } from "../server/index.mjs";

const connectionString = process.env.E2E_DATABASE_URL;
if (!connectionString) throw new Error("E2E_DATABASE_URL is required and must name a dedicated disposable *_test database.");
const targetUrl = new URL(connectionString);
const databaseName = decodeURIComponent(targetUrl.pathname.slice(1));
if (!/(^|[_-])test$/i.test(databaseName)) throw new Error("E2E_DATABASE_URL database name must end in _test (for example schedulify_e2e_test).");
if (process.env.DATABASE_URL && new URL(process.env.DATABASE_URL).pathname === targetUrl.pathname) {
  throw new Error("E2E_DATABASE_URL must be a different database from DATABASE_URL.");
}

const ssl = process.env.E2E_DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined;
const adminPool = new Pool({ connectionString, max: 2, ssl, connectionTimeoutMillis: 5_000 });
const schema = `schedulify_e2e_${randomBytes(8).toString("hex")}`;
if (!/^schedulify_e2e_[0-9a-f]{16}$/.test(schema)) throw new Error("Refusing to use an unexpected E2E schema name.");
let appPool;
let apiServer;
let webServer;
let controlServer;
let schemaCreated = false;
let originalEnvironment;
let databaseUnavailable = false;

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(server.address()); });
  });
}

function startChild(command, args, env) {
  const child = spawn(command, args, { cwd: process.cwd(), env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const append = (chunk) => { output = `${output}${chunk}`.slice(-4000); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.outputTail = () => output.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[database URL redacted]");
  return child;
}

async function waitForReady(url, child) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite exited before becoming ready: ${child.outputTail()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out starting the E2E frontend: ${lastError?.message || "unknown error"}; ${child.outputTail()}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
  timeout.unref();
  await closed;
  clearTimeout(timeout);
}

try {
  const identity = await adminPool.query("SELECT current_database() AS name, current_setting('server_version_num') AS version");
  if (identity.rows[0].name !== databaseName) throw new Error("Connected database does not match E2E_DATABASE_URL.");
  console.info(`E2E PostgreSQL ${identity.rows[0].version}; isolated schema ${schema}.`);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;

  const isolatedUrl = new URL(connectionString);
  isolatedUrl.searchParams.set("options", `-c search_path=${schema}`);
  appPool = new Pool({ connectionString: isolatedUrl.href, max: 12, ssl, connectionTimeoutMillis: 5_000, statement_timeout: 15_000, query_timeout: 20_000 });
  await runMigrations(appPool);

  const password = "E2E-schedulify-pass-2026";
  const passwordHash = await bcrypt.hash(password, 4);
  for (const [name, role] of [["Administrator", "Admin"], ["HOD Reviewer", "HOD"], ["Teacher One", "Teacher"], ["Teacher Two", "Teacher"], ["Student One", "Student"], ["Student Two", "Student"]]) {
    const slug = name.toLowerCase().replaceAll(" ", ".");
    await appPool.query("INSERT INTO users(id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5)", [randomUUID(), name, `${slug}@e2e.test`, passwordHash, role]);
  }

  const webPort = 4177;
  const webOrigin = `http://127.0.0.1:${webPort}`;
  originalEnvironment = {
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_SSL: process.env.DATABASE_SSL,
    COOKIE_SECURE: process.env.COOKIE_SECURE,
    PUBLIC_APP_ORIGIN: process.env.PUBLIC_APP_ORIGIN,
  };
  process.env.DATABASE_URL = isolatedUrl.href;
  process.env.DATABASE_SSL = process.env.E2E_DATABASE_SSL || "false";
  process.env.COOKIE_SECURE = "false";
  process.env.PUBLIC_APP_ORIGIN = webOrigin;

  controlServer = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/database-state") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const input = JSON.parse(body);
      if (typeof input.unavailable !== "boolean") throw new Error("invalid_state");
      databaseUnavailable = input.unavailable;
      res.writeHead(204).end();
    } catch {
      res.writeHead(400).end();
    }
  });
  const controlAddress = await listen(controlServer);

  apiServer = createApiServer({
    poolProvider: () => databaseUnavailable
      ? { query: async () => { throw Object.assign(new Error("injected database connection failure"), { code: "ECONNREFUSED" }); } }
      : appPool,
    interpret: async ({ request }) => {
      if (/missing config/i.test(request)) return { status: 503, body: { error: "AI is not configured. Set OPENAI_API_KEY on the server to enable interpretation." } };
      if (/malformed/i.test(request)) return { status: 502, body: { error: "The AI provider returned malformed structured data." } };
      return { status: 200, body: {
        summary: "Keep Friday afternoons free for all batches.",
        rules: [{ type: "keep_day_free", priority: "hard", batch: null, teacher: null, subject: null, room: null, day: "Fri", period: "afternoon", explanation: "Keep Friday afternoons free.", validation: "ready", clarification: null }],
        nextSteps: [],
      } };
    },
  });
  const apiAddress = await listen(apiServer);
  webServer = startChild(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], {
    ...process.env,
    VITE_API_PROXY_TARGET: `http://127.0.0.1:${apiAddress.port}`,
    VITE_BASE_PATH: "/",
  });
  await waitForReady(webOrigin, webServer);

  const cli = fileURLToPath(new URL("../node_modules/@playwright/test/cli.js", import.meta.url));
  const result = await new Promise((resolve, reject) => {
    const runner = spawn(process.execPath, [cli, "test", "--config=playwright.config.mjs"], {
      cwd: process.cwd(), windowsHide: true, stdio: "inherit",
      env: { ...process.env, PLAYWRIGHT_BASE_URL: webOrigin, E2E_TEST_PASSWORD: password, E2E_CONTROL_URL: `http://127.0.0.1:${controlAddress.port}` },
    });
    runner.once("error", reject);
    runner.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  process.exitCode = result;
} finally {
  await stopChild(webServer);
  if (apiServer?.listening) await new Promise((resolve) => {
    apiServer.close(resolve);
    apiServer.closeAllConnections?.();
  });
  if (controlServer?.listening) await new Promise((resolve) => controlServer.close(resolve));
  if (appPool) await appPool.end();
  if (schemaCreated) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
  if (originalEnvironment) {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}
