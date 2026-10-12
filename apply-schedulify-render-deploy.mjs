import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const staged = new Map();
async function readText(path) {
  const raw = await readFile(resolve(root, path), "utf8");
  return { text: raw.replace(/\r\n/g, "\n"), newline: raw.includes("\r\n") ? "\r\n" : "\n" };
}
function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(label + ": expected one matching anchor, found " + count + ". No files were changed.");
  return source.replace(before, after);
}
function stage(path, text, newline = "\n") { staged.set(path, text.replace(/\n/g, newline)); }

// Serve the built Vite bundle and API from one same-origin Node service.
const apiPath = "server/index.mjs";
const apiFile = await readText(apiPath);
let api = apiFile.text;
if (!api.includes("async function serveWeb(req, res, url)")) {
  api = replaceOnce(api,
    'import { createServer } from "node:http";\nimport { pathToFileURL } from "node:url";',
    'import { createServer } from "node:http";\nimport { readFile, stat } from "node:fs/promises";\nimport { extname, resolve, sep } from "node:path";\nimport { fileURLToPath, pathToFileURL } from "node:url";',
    apiPath + " imports");
  api = replaceOnce(api,
    'const PORT = Number(process.env.API_PORT || 3001);',
    'const PORT = Number(process.env.PORT || process.env.API_PORT || 3001);',
    apiPath + " port");
  const helper = `const buckets = new Map();
const WEB_ROOT = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
const WEB_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function serveWeb(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 404, { error: "Not found" });
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { return send(res, 400, { error: "Invalid path." }); }
  let target = resolve(WEB_ROOT, "." + pathname);
  if (target !== WEB_ROOT && !target.startsWith(WEB_ROOT + sep)) return send(res, 404, { error: "Not found" });
  let content;
  try {
    if ((await stat(target)).isDirectory()) target = resolve(target, "index.html");
    content = await readFile(target);
  } catch {
    if (extname(pathname)) return send(res, 404, { error: "Not found" });
    target = resolve(WEB_ROOT, "index.html");
    try { content = await readFile(target); }
    catch { return send(res, 503, { error: "Web assets are unavailable." }); }
  }
  const hashedAsset = target.startsWith(resolve(WEB_ROOT, "assets") + sep);
  res.writeHead(200, {
    "content-type": WEB_TYPES[extname(target)] || "application/octet-stream",
    "content-length": content.length,
    "cache-control": hashedAsset ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : content);
}

function send(res, status, data) {`;
  api = replaceOnce(api, 'const buckets = new Map();\n\nfunction send(res, status, data) {', helper, apiPath + " static web handler");
  api = replaceOnce(api,
    '  let session;\n  try { session = await authenticateRequest(req, poolProvider()); }',
    '  if (process.env.NODE_ENV === "production" && url.pathname !== "/api" && !url.pathname.startsWith("/api/")) return serveWeb(req, res, url);\n  let session;\n  try { session = await authenticateRequest(req, poolProvider()); }',
    apiPath + " frontend fallback");
  api = replaceOnce(api,
    'process.env.NODE_ENV === "production" && (process.env.COOKIE_SECURE !== "true" || !process.env.PUBLIC_APP_ORIGIN?.startsWith("https://"))',
    'process.env.NODE_ENV === "production" && (process.env.COOKIE_SECURE !== "true" || !(process.env.PUBLIC_APP_ORIGIN || (process.env.RENDER_EXTERNAL_HOSTNAME ? "https://" + process.env.RENDER_EXTERNAL_HOSTNAME : "")).startsWith("https://"))',
    apiPath + " production origin guard");
  stage(apiPath, api, apiFile.newline);
}

// Render's default HTTPS host becomes the expected Origin when no custom origin is configured.
const authPath = "server/auth.mjs";
const authFile = await readText(authPath);
let auth = authFile.text;
if (!auth.includes("process.env.RENDER_EXTERNAL_HOSTNAME")) {
  auth = replaceOnce(auth,
    'function expectedOrigin(req) {\n  if (process.env.PUBLIC_APP_ORIGIN) return process.env.PUBLIC_APP_ORIGIN.replace(/\\/$/, "");\n  const proto = req.socket.encrypted ? "https" : "http";\n  return `${proto}://${req.headers.host}`;\n}',
    'function expectedOrigin(req) {\n  if (process.env.PUBLIC_APP_ORIGIN) return process.env.PUBLIC_APP_ORIGIN.replace(/\\/$/, "");\n  if (process.env.RENDER_EXTERNAL_HOSTNAME) return "https://" + process.env.RENDER_EXTERNAL_HOSTNAME;\n  const proto = req.socket.encrypted ? "https" : "http";\n  return `${proto}://${req.headers.host}`;\n}',
    authPath + " expected origin");
  stage(authPath, auth, authFile.newline);
}

// Add a production static-serving smoke test to the existing single CI verification command.
const packagePath = "package.json";
const packageFile = await readText(packagePath);
const pkg = JSON.parse(packageFile.text);
pkg.scripts["test:production-web"] = "node --test tests/production-web.test.mjs";
pkg.scripts.verify = "npm run test:unit && npm run lint && npm run test:db && npm run test:e2e && npm run build && npm run test:production-web";
stage(packagePath, JSON.stringify(pkg, null, 2) + "\n", packageFile.newline);

const testFile = String.raw`import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../server/index.mjs";

test("production server serves the built React app and API from one origin", async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const server = createApiServer({ poolProvider: () => { throw new Error("liveness must not query PostgreSQL"); } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  try {
    const home = await fetch(origin + "/");
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type") || "", /text\/html/);
    const html = await home.text();
    const script = html.match(/src="([^"]+\.js)"/);
    assert.ok(script, "built HTML should reference a JavaScript bundle");
    const asset = await fetch(new URL(script[1], origin));
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") || "", /javascript/);
    const cssPath = html.match(/href="([^"]+\.css)"/);
    assert.ok(cssPath, "built HTML should reference a CSS bundle");
    const css = await fetch(new URL(cssPath[1], origin));
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") || "", /text\/css/);
    const deepLink = await fetch(origin + "/admin");
    assert.equal(deepLink.status, 200);
    assert.match(deepLink.headers.get("content-type") || "", /text\/html/);
    const live = await fetch(origin + "/api/health/live");
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { ok: true });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
`;
stage("tests/production-web.test.mjs", testFile.replace(/\\n/g, "\n"));

const workflowPath = ".github/workflows/ci.yml";
const workflowFile = await readText(workflowPath);
let workflow = workflowFile.text;
if (!workflow.includes("Production web smoke test")) {
  workflow = replaceOnce(workflow,
    "      - name: Production build\n        run: npm run build\n",
    "      - name: Production build\n        run: npm run build\n      - name: Production web smoke test\n        run: npm run test:production-web\n",
    "CI production web smoke test");
  stage(workflowPath, workflow, workflowFile.newline);
}

const renderYaml = `services:
  - type: web
    name: schedulify-portfolio-demo
    runtime: node
    plan: free
    region: singapore
    buildCommand: npm ci --include=dev && npm run build
    startCommand: npm run db:migrate && npm run start:api
    healthCheckPath: /api/health/ready
    envVars:
      - key: NODE_ENV
        value: production
      - key: DATABASE_URL
        sync: false
      - key: DATABASE_SSL
        value: "true"
      - key: COOKIE_SECURE
        value: "true"
`;
stage("render.yaml", renderYaml);
stage(".node-version", "22.23.3\n");

const readmePath = "README.md";
const readmeFile = await readText(readmePath);
let readme = readmeFile.text;
if (!readme.includes("## Deploy a portfolio demo")) {
  readme = replaceOnce(readme, "## Run locally", "## Deploy a portfolio demo\n\nA no-Docker deployment recipe for a public React + Node app with PostgreSQL is in [DEPLOYMENT.md](./DEPLOYMENT.md#portfolio-demo-deployment-render--neon). The included Render Blueprint serves frontend assets and /api/* from one origin; Neon supplies PostgreSQL. Passing CI verifies code checks; it does not itself mean a live deployment exists.\n\n## Run locally", "README deployment section");
  stage(readmePath, readme, readmeFile.newline);
}

const deploymentPath = "DEPLOYMENT.md";
const deploymentFile = await readText(deploymentPath);
let deployment = deploymentFile.text;
if (!deployment.includes("## Portfolio demo deployment: Render + Neon")) {
  const section = `## Portfolio demo deployment: Render + Neon

This route avoids Docker and keeps the UI and API on the same HTTPS origin, preserving the session-cookie and Origin/CSRF model. The root render.yaml is a Blueprint for the web service. A separate Neon PostgreSQL database supplies persistent data.

1. Create a PostgreSQL project on [Neon](https://neon.com/). Copy its pooled connection string from the Connect dialog and keep it private. Prefer a Neon region close to Render's Singapore region.
2. Open [Render Blueprints](https://dashboard.render.com/blueprints), connect this repository, select render.yaml, and create the service. Render will prompt for DATABASE_URL; paste the Neon pooled connection string. The app derives its same-origin HTTPS URL from Render's RENDER_EXTERNAL_HOSTNAME for the default onrender.com URL.
3. After the first deploy is healthy, bootstrap the first Admin once from PowerShell in a checkout of this repository. This writes to the Neon database, so double-check the connection string belongs to the intended Schedulify project:

   ~~~powershell
   $ptr = [IntPtr]::Zero
   try {
     $secret = Read-Host "Neon pooled connection string" -AsSecureString
     $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
     $env:DATABASE_URL = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
     $env:DATABASE_SSL = "true"
     npm run auth:bootstrap
   } finally {
     if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
     Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
     Remove-Item Env:DATABASE_SSL -ErrorAction SilentlyContinue
   }
   ~~~

   Enter a name, email, and a unique password when prompted. Do not run bootstrap again after the first Admin exists.
4. Open the Render URL, sign in as Admin, and create fictional demo resources and role accounts. Link each Teacher account to its teacher record and assign each Student to a batch before testing scoped views. Generate a candidate, check validation, then approve it with an HOD account.
5. AI interpretation is optional and requires the server-side OPENAI_API_KEY. Manual scheduling works without the key. Store it only in Render's private environment settings, never in Git or a VITE_* variable.

**Free-tier caveat:** Render free web services sleep after 15 minutes idle and can take around a minute to wake. Check current provider quotas before relying on them for anything important. Do not use this demo for real student data or a critical timetable.

`;
  deployment = replaceOnce(deployment, "## Before choosing a host", section + "## Before choosing a host", "deployment guide insertion");
  deployment = deployment.replace(/^# Production deployment checklist\n\n[\s\S]*?(?=\n## Portfolio demo deployment: Render \+ Neon)/, "# Production deployment checklist\n\nThis guide includes a no-Docker portfolio deployment path using a single Render web service for the React frontend and Node API, plus a managed Neon PostgreSQL database. It also retains the Docker/Nginx Compose path for self-managed deployments. Hosted CI passing verifies code checks; it does not imply that a live service is deployed.\n\nThe staging runbook describes a separate Lightsail option; no AWS resources have been created.\n\n");
  deployment = deployment.replace("- **Not verified:** hosted GitHub Actions, Docker image builds, container runtime/proxy behavior, HTTPS ingress and Secure-cookie behavior on a real host, managed database networking, provider backups/PITR, and a live deployment.", "- **Not verified:** Docker image/runtime behavior, a live Render/Neon deployment, real hosted HTTPS/session behavior, managed database backup/recovery, and production operations. Hosted GitHub Actions run 38209513062 passed unit, lint, audit, PostgreSQL integration, Chromium E2E, and build steps.");
  stage(deploymentPath, deployment, deploymentFile.newline);
}

for (const [path, content] of staged) await writeFile(resolve(root, path), content, "utf8");
console.log("Prepared Render + Neon portfolio deployment in " + staged.size + " files:");
for (const path of staged.keys()) console.log("  " + path);
console.log("Next: run npm run build && npm run test:production-web && npm run lint once, commit/push, create the Neon database, then import render.yaml in Render. Hosted CI runs the full suite on push.");