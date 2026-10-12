# Production deployment checklist

This guide includes a no-Docker portfolio deployment path using a single Render web service for the React frontend and Node API, plus a managed Neon PostgreSQL database. It also retains the Docker/Nginx Compose path for self-managed deployments. Hosted CI passing verifies code checks; it does not imply that a live service is deployed.

The staging runbook describes a separate Lightsail option; no AWS resources have been created.


## Portfolio demo deployment: Render + Neon

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

## Before choosing a host

- Choose a host that can run the included Docker images, keep the API private, expose the web service through HTTPS ingress, and reach a persistent PostgreSQL service over TLS.
- Decide database backup retention, recovery objectives, secret storage, TLS termination, log retention, and a rollback owner. These are operator/provider responsibilities and are not provisioned by this repository.
- Keep the API and database off the public ingress. `compose.release.example.yml` publishes only the web container on port 8080, exposes the API only to the Compose network, and expects PostgreSQL to be external.

## Production environment

Copy `.env.production.example` to `.env.production` on the deployment host, store it outside source control, and provide real values through the host's protected secret mechanism where available:

| Variable | Requirement |
| --- | --- |
| `DATABASE_URL` | Required. Connection string for the application database and a dedicated least-privilege application role. Never use a database owner or administrator credential for normal API traffic. |
| `DATABASE_SSL` | Set to `true` when the database requires TLS; the Node client verifies the server certificate. |
| `COOKIE_SECURE` | Must be `true` in production. Serve the public site over HTTPS. |
| `PUBLIC_APP_ORIGIN` | Required in production; the exact browser origin, including `https://` and any non-default port, with no path. Used for same-origin request checks. |
| `OPENAI_API_KEY` | Optional. Server-side only; needed only for AI interpretation. Do not use a `VITE_` prefix or include it in frontend build arguments. |
| `OPENAI_API_URL`, `OPENAI_MODEL` | Optional provider configuration. Keep these on the API host. |
| `API_HOST`, `API_PORT` | Compose sets `0.0.0.0:3001` inside the API container. Local defaults are `0.0.0.0` and `3001`; do not expose this port publicly. |

The application does not enable permissive CORS. The supported browser/API topology is one public HTTPS origin: ingress routes the site to Nginx, and Nginx proxies `/api/` to the private API. The proxy passes the incoming `Host` and request forwarding headers. Set `PUBLIC_APP_ORIGIN` to the browser-visible origin; do not add cross-origin frontend/API origins as a workaround. Session cookies are HttpOnly, SameSite=Lax, Secure in production, and scoped to `/`; state-changing requests also require the session CSRF token and matching `Origin`.

## Release procedure

1. Create the external PostgreSQL database and a dedicated role with only the permissions needed by the app and controlled migrations. Restrict network ingress to the API and release operator; require TLS when supported by the service.
2. Create `.env.production` from the example and validate the origin, database URL, TLS, cookie, and provider settings. Do not place secrets in Git, image build arguments, frontend variables, or logs.
3. Establish a recoverable database backup and record the API image/version currently serving traffic.
4. Build the API and web images with `docker compose -f compose.release.example.yml build`.
5. Apply migrations as a controlled release step: `docker compose -f compose.release.example.yml run --rm api node server/migrate.mjs`. Migrations are not run automatically when the API starts.
6. Provision the initial administrator once, using a protected interactive session: `docker compose -f compose.release.example.yml run --rm -it api node scripts/bootstrap-admin.mjs`. Do not automate a default password.
7. Start the stack with `docker compose -f compose.release.example.yml up -d` and confirm ingress exposes only the HTTPS web endpoint.
8. Verify `GET /api/health/live` through the public origin (process liveness) and `GET /api/health/ready` (API plus PostgreSQL readiness). Then sign in as the provisioned Admin, verify a state-changing action has CSRF protection, generate and validate a candidate, approve it as HOD, and confirm linked Teacher/Student views are scoped.
9. Check logs for startup or migration errors without printing environment values. Keep the prior API image available until the release has passed its smoke checks.

The Nginx health check calls the API liveness route through the proxy. API readiness is separately provided by `/api/health/ready` and performs `SELECT 1`; it returns 503 when PostgreSQL is unavailable. Liveness only confirms the API process is responding. These checks do not replace the authenticated workflow smoke test.

## Recovery

- Configure encrypted managed backups or point-in-time recovery with the selected PostgreSQL provider; this repository does not configure backup schedules, retention, encryption, or PITR.
- Before migrations, create a provider recovery point or protected custom-format dump. Periodically restore into a new disposable database, check `schema_migrations` and expected application records, then run readiness and integration checks against the restored copy.
- If an application release fails, route traffic back to the retained prior web/API image after confirming database schema compatibility. Do not assume an old application image can use a newer schema; use a reviewed forward migration or restore the database into a separate instance before any recovery cutover.
- Never test restore, rollback, or cleanup commands against the live database. Do not overwrite the current database during a recovery exercise.

## Verification status

- **Verified locally:** After the Tailwind PostCSS correction, `npm run verify` completed with 35 unit tests, lint, 2 PostgreSQL integration tests, 3 Chromium E2E tests, and a production build; `npm audit` reported zero vulnerabilities. A separate Chromium CSS smoke check loaded `/src/index.css` successfully. PostgreSQL 18.6 ran in a disposable cluster bound to `127.0.0.1:55432`; it was stopped after verification.
- **Static checks:** CI workflow YAML and release Compose configuration parse successfully. The workflow includes install, unit tests, lint, full dependency audit, PostgreSQL integration, Chromium E2E, and build; failures stop the job. Integration tests require an explicit `TEST_DATABASE_URL`, assert the connected database identity, require a test-named database distinct from `DATABASE_URL`, and create/drop only a random test schema.
- **Not verified:** a hosted GitHub Actions run for the corrected snapshot (the pre-fix run failed E2E), Docker image builds, container runtime/proxy behavior, HTTPS ingress and Secure-cookie behavior on a real host, managed database networking, provider backups/PITR, and a live deployment.
