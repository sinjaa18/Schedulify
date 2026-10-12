# Schedulify staging runbook

This is a planned, disposable staging deployment for the current Compose topology. It is not an authorization to provision AWS resources. No cloud resources, credentials, commits, or pushes were created for this runbook. Use synthetic data and accounts only.

## Target and estimated cost

Suggested temporary target, subject to approval and current AWS pricing:

| Resource | Staging size | Estimated price |
| --- | --- | ---: |
| Lightsail Linux/Unix VM in Mumbai | Small 2 GB, 2 vCPU, 60 GB SSD, public IPv4 | $12 USD/month |
| Lightsail managed PostgreSQL database in the same account/Region, private mode | Standard 2 GB, 80 GB SSD, 100 GB transfer, encrypted plan | $30 USD/month |
| **Estimated total** | One VM and one managed database | **$42 USD/month** |

Estimate is before taxes, domain registration, snapshot storage, and transfer overages. Mumbai's instance transfer allowance is 1.5 TB for the 2 GB bundle; the database plan includes 100 GB. The Lightsail documentation lists the smallest 1 GB/40 GB database tier at $15/month, but that plan is not the encrypted tier; the estimate above uses the encrypted 2 GB plan. Confirm the available PostgreSQL engine version, plan, and current account pricing before creating resources. AWS lists instance bundles and managed database plans on its [Lightsail pricing page](https://aws.amazon.com/lightsail/pricing/), and specifies the Mumbai transfer allowance in its [Lightsail transfer FAQ](https://aws.amazon.com/lightsail/faq/). Snapshot storage is billed separately at $0.05/GB-month. Prices and tax treatment can change.

## Prerequisites

- An approved Git commit containing the intended release snapshot and a green hosted CI run. The current local release snapshot is uncommitted, so it cannot be cloned by the VM yet.
- An AWS account with Lightsail in `ap-south-1` (Mumbai), a person authorized to create/delete the proposed VM and database, and a billing alert.
- A DNS name you control, pointed to the VM's static IPv4 address. Domain purchase cost is not included above. HTTPS requires a publicly resolvable name and inbound TCP 80/443 for certificate issuance and renewal.
- The approved operator's SSH public key and fixed public IP/CIDR. Keep the private key outside the repository and restrict its local file permissions.
- A dedicated staging database, credentials, and database TLS details. Do not reuse production credentials, clone production data, or enable database public mode.

The managed database should be private and in the same Lightsail account and Region as the VM. Lightsail documents private databases as accessible only to Lightsail resources in the same account; do not enable public mode or open PostgreSQL to the internet. [AWS private database access](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-configuring-database-public-mode.html)

## Provisioning and host security

After explicit approval to create the staging resources:

1. Create the Ubuntu Linux/Unix 2 GB Lightsail instance in Mumbai and attach a static IPv4 address. Create the encrypted 2 GB managed PostgreSQL plan in the same account and Region, using a new staging database and unique credentials. Leave the database in private mode.
2. In both the Lightsail IPv4 and IPv6 firewalls, allow TCP 22 only from the operator's public IP/CIDR, and TCP 80/443 for public web and HTTPS. Remove broad default SSH access. Do not add 8080, 3001, or 5432 rules. AWS documents the Lightsail firewall as separate for IPv4 and IPv6 and recommends restricting SSH sources: [Lightsail firewall guidance](https://docs.aws.amazon.com/lightsail/latest/userguide/understanding-firewall-and-port-mappings-in-amazon-lightsail.html).
3. SSH with the region's Lightsail key pair; use the `ubuntu` account and `sudo`, not root login. Patch the OS. After confirming key access in a second SSH session, set effective SSH policy to `PasswordAuthentication no` and `PermitRootLogin no`, validate with `sudo sshd -t`, and reload the SSH service. Configure UFW to allow SSH only from the operator CIDR plus public 80/443; do not open 8080 or 5432. Docker-published ports can bypass some host firewall chains, so the Lightsail firewall must also keep 8080 closed.
4. Install Docker Engine and the Compose plugin from Docker's official Ubuntu apt repository. Keep Docker commands under `sudo` rather than adding general users to the Docker group. Verify `sudo docker version` and `sudo docker compose version`. Follow the maintained [Docker Ubuntu installation guide](https://docs.docker.com/engine/install/ubuntu/).
5. Configure DNS A record to the static IPv4. Install Caddy using its [official Debian/Ubuntu package instructions](https://caddyserver.com/docs/install) and use it as the host HTTPS terminator:

   ```caddyfile
   staging.example.org {
       reverse_proxy 127.0.0.1:8080
   }
   ```

   Save it as `/etc/caddy/Caddyfile`, validate with `sudo caddy validate --config /etc/caddy/Caddyfile`, and apply with `sudo systemctl reload caddy`. The Caddy package runs as a system service and automatically obtains/renews a certificate for the configured domain when DNS and ports 80/443 are reachable. Do not serve the app on a raw public IP over HTTP. [Caddy HTTPS quick start](https://caddyserver.com/docs/quick-starts/https)

## Release install and configuration

After the approved commit has passed hosted CI, connect to the VM and check out that exact commit (replace the placeholders; do not deploy a moving branch head):

```sh
sudo install -d -o ubuntu -g ubuntu /opt/schedulify
git clone https://github.com/sinjaa18/Schedulify-SIHPrototype.git /opt/schedulify/repo
cd /opt/schedulify/repo
git checkout <approved-release-commit>
git rev-parse HEAD
sudo install -d -o root -g root -m 700 /etc/schedulify
sudo install -o root -g root -m 600 /dev/null /etc/schedulify/staging.env
sudoedit /etc/schedulify/staging.env
sudo ln -s /etc/schedulify/staging.env /opt/schedulify/repo/.env.production
```

Use SSH deploy credentials only if the repository is private; do not save a personal access token in the clone URL or shell history. Confirm `git rev-parse HEAD` is the CI-verified commit.

The commands above create a root-readable environment file outside the repository checkout, then symlink it to the `.env.production` path Compose expects. Populate it using the deployment operator's secret manager. Do not paste secret values in shell commands, logs, tickets, or Git. Set these values in `/etc/schedulify/staging.env`:

```dotenv
DATABASE_URL=postgres://<staging_role>:<url_encoded_secret>@<private_db_endpoint>:5432/<staging_database>
DATABASE_SSL=true
COOKIE_SECURE=true
PUBLIC_APP_ORIGIN=https://staging.example.org
OPENAI_API_KEY=
# Optional only when needed:
# OPENAI_API_URL=https://api.openai.com/v1/chat/completions
# OPENAI_MODEL=<approved-model>
```

Compose sets `NODE_ENV=production`, `API_HOST=0.0.0.0`, and `API_PORT=3001`. `PUBLIC_APP_ORIGIN` must exactly match the browser-visible HTTPS origin. `DATABASE_SSL=true` enables certificate verification; ensure the managed database certificate chain is trusted by the Node runtime. The API key is optional and remains server-side. The frontend calls same-origin `/api`; permissive CORS is not enabled. Never pass these values as `VITE_*` variables or frontend build arguments.

The application Compose file expects `.env.production` beside the Compose file. The symlink above keeps the actual secret file under `/etc/schedulify`, outside the checkout; ensure the target exists and is root-readable before invoking Compose with `sudo`. The symlink is ignored by Git. Use a separate staging database role with only the permissions required by the app and migrations.

## Build, migrate, bootstrap, and start

Build sequentially to reduce peak memory on the 2 GB VM:

```sh
cd /opt/schedulify/repo
sudo docker compose -p schedulify-staging -f compose.release.example.yml config --quiet
sudo docker compose -p schedulify-staging -f compose.release.example.yml build api
sudo docker compose -p schedulify-staging -f compose.release.example.yml build web
```

Take a pre-migration database snapshot/restore point. Apply SQL migrations as a controlled release step, then bootstrap exactly one initial Admin interactively:

```sh
sudo docker compose -p schedulify-staging -f compose.release.example.yml run --rm api node server/migrate.mjs
sudo docker compose -p schedulify-staging -f compose.release.example.yml run --rm -it api node scripts/bootstrap-admin.mjs
sudo docker compose -p schedulify-staging -f compose.release.example.yml up -d
```

Migrations are recorded in `schema_migrations` and can be rerun; the integration suite verified rerun idempotency. Admin bootstrap is intentionally one-time: it refuses to create an additional initial Admin. Do not rerun it after the first account exists. The Compose stack does not contain PostgreSQL or a database volume; persistence is in the external managed database. It publishes web port 8080 on the VM, so rely on both cloud firewalls leaving 8080 closed; Caddy reaches the service locally on `127.0.0.1:8080`. API port 3001 is only exposed inside the Compose network.

## Health, logs, rollback, and cleanup

```sh
sudo docker compose -p schedulify-staging -f compose.release.example.yml ps
sudo docker compose -p schedulify-staging -f compose.release.example.yml logs --tail=200 api web
curl --fail https://staging.example.org/
curl --fail https://staging.example.org/api/health/live
curl --fail https://staging.example.org/api/health/ready
```

Liveness should return 200 while the API process runs. Readiness should return 200 only when PostgreSQL answers `SELECT 1`; database loss should produce 503 without disclosing database details. The API's Docker health check uses readiness and the web health check uses the proxied liveness route. Compose waits for a healthy API before starting the web service.

Before a new release, record the currently deployed commit and the `docker image inspect` IDs for both Compose images. Keep the prior image IDs and database recovery point. On an application failure, restore the prior image IDs and recreate containers; do not assume a database schema downgrade is safe. If a migration caused a data/schema problem, restore a snapshot into a separate database and verify it before any cutover. Never run `docker compose down -v` against any deployment as a casual cleanup step.

For planned cleanup, stop and remove only the named staging Compose project, then delete the staging managed database and VM after deciding whether to retain a manual snapshot. Lightsail resources continue to incur charges while stopped; delete the temporary resources when the test is finished. Verify IPv4/IPv6 firewall rules, DNS, snapshots, and billing after deletion. Do not use production credentials/data in cleanup or recovery exercises.

## Repeatable staging smoke tests

Use a disposable domain, synthetic timetable records, and unique staging users: one Admin, one HOD, one linked Teacher, and one Student assigned to a test batch. Record only pass/fail, status codes, and release commit; do not save cookies or passwords in reports.

| Check | Action | Expected result |
| --- | --- | --- |
| Frontend and TLS | Load `https://staging.example.org/`; inspect certificate and browser network. | Trusted certificate, HTTPS, React shell loads; direct `http://` redirects to HTTPS. |
| API proxy and readiness | Request `/api/health/live` and `/api/health/ready` on the same origin. | Both return 200 while healthy; no cross-origin API URL or CORS dependency. |
| Session cookie | Sign in as staging Admin and inspect the cookie flags in browser devtools. | Cookie is HttpOnly, Secure, SameSite=Lax, path `/`; no session token in local storage. |
| CSRF and origin | Attempt a state-changing request without the CSRF token, then with a mismatched Origin. | Both are rejected (403); valid same-origin request with token is accepted. |
| Login/logout/revocation | Sign in, save a disposable browser session only for this check, log out, then retry a protected request with the old cookie. Also test a role change revokes an already-issued session. | Login works; logout and role change revoke sessions; old cookie receives 401. Delete saved cookie immediately. |
| Generation and validation | Configure a small synthetic domain with eligible teachers, rooms, availability, and exact requirements; generate as Admin. | Candidate is complete, persisted, and independently validated. Infeasible input reports failure and creates no successful candidate. |
| HOD publication | Sign in as HOD, publish a valid candidate, then change domain inputs and try approving the stale version. | Valid candidate publishes; stale candidate is rejected. |
| Scoped views | Sign in as linked Teacher and Student; request own timetable and try forged teacher/batch query identifiers. | Each sees only its linked schedule; forged identifiers do not widen access. |
| API outage | Stop only the staging API container, request frontend and `/api`, then start it again. | Static page may load, API proxy fails clearly, and service recovers after restart. |
| Database outage | Only in isolated staging, temporarily point the staging API at a known-unreachable disposable endpoint or use a provider-approved reversible network isolation; restore the original staging URL immediately afterward. | Liveness can remain 200; readiness/auth return controlled 503; no database internals leak; restoring connectivity recovers without data changes. Do not toggle or interrupt a production database. |

Local E2E already exercises login/logout, session revocation, scheduler/validator behavior, HOD approval, scoped accounts, injected database failure/recovery, and user-facing API outage behavior. This staging smoke plan has **not** been executed; it must be recorded separately from those local test results.
