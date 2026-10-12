# Schedulify Architecture

## Runtime boundaries

React/Vite provides the interface and an unsaved Admin domain draft. PostgreSQL is authoritative for resources, weekly requirements, availability, confirmed Copilot constraints, accounts, timetable versions, assignments, and approval history. The Node API owns authentication, authorization, mutations, generation, independent validation, publication, and scoped timetable reads. `src/utils/scheduler.js` and `src/utils/validator.js` are plain JavaScript modules shared by the frontend build and Node service; the browser no longer generates or approves schedules.

## Identity and permissions

`server/auth.mjs` verifies bcrypt password hashes, issues opaque HttpOnly session cookies, stores only token digests, enforces same-origin CSRF, and revokes sessions after role changes. Public signup is disabled. Admin provisions roles and links Teacher users to one `teachers` row or Student users to one `student_profiles` batch. Unique and foreign-key constraints protect these links. A role change clears old links; the Admin must create the new role's link. HOD approval uses the existing HOD role; no extra HOD resource association is required.

| Operation | Admin | HOD | Teacher | Student |
| --- | --- | --- | --- | --- |
| Read resources, rules, and version list/detail | Yes | Yes | No | No |
| Replace resource domain / confirmed rules | Yes | No | No | No |
| Generate candidate | Yes | No | No | No |
| Approve or reject candidate | No | Yes | No | No |
| Read published own/assigned schedule | No | No | Linked teacher only | Assigned batch only |
| Provision accounts, change roles, set links | Yes | No | No | No |
| Interpret Copilot request | Yes | No | No | No |

Every state-changing route requires a verified session, role authorization, and CSRF token. IDs for the Teacher/Student timetable view come from database joins on the authenticated user, never request parameters. Copilot receives its catalog from PostgreSQL; interpreted rules are only scheduling input after an Admin confirmation.

## PostgreSQL model

`001_identity.sql` defines users and sessions. `002_scheduling_domain.sql` adds:

- `batches`, `subjects`, `teachers`, `rooms` with stable IDs and case-insensitive unique names.
- `batch_requirements` with exact weekly session counts per batch and subject.
- `teacher_subjects` plus batch, teacher, and room availability relations.
- Unique `teachers.user_id` and one-row `student_profiles(user_id, batch_id)` identity links.
- `confirmed_constraints` JSONB rules with confirming user, timestamp, and revision.
- `domain_revision`, the optimistic-concurrency token for scheduler inputs.
- `timetable_versions` with status, source revision, creator, validator output, diagnostics, stats, and approval/rejection metadata.
- `timetable_entries` with foreign keys to version and resources, day/slot uniqueness constraints, readable name snapshots, and a requirement ID snapshot.
- `approval_events` for publication, rejection, stale, and revalidation-failure audit records.

Resource and constraint mutations run transactionally while locking `domain_revision`, then increment it. Current candidate and approved versions become `stale` on any scheduler-input change. History rows remain. Foreign keys prevent removal of resources that historical assignments still reference; requirement identifiers in old rows are snapshots and do not prevent weekly requirements from changing.

## Generation, validation, and publication

`POST /api/timetables/generate` accepts bounded search budgets only. The service reads a repeatable-read snapshot of canonical domain/rules, calls the existing deterministic scheduler with its limits, independently validates a complete result, then locks/rechecks the revision before persisting candidate and entries. Failed, incomplete, or invalid candidates are never persisted as successful schedules. Search outcome status and diagnostics remain distinct.

Lifecycle: `candidate → approved → superseded`; a domain/rule change makes current `candidate` and `approved` versions `stale`; HOD rejection makes a candidate `rejected`; failed final validation records `rejected` plus an audit event. Approval locks the revision and version, verifies the candidate and source revision, reloads actual persisted assignments, independently validates them, supersedes the previous publication, and records the HOD and timestamp in one transaction. A partial unique index permits only one approved publication.

## API map

- `GET /api/domain` (Admin/HOD), `PUT /api/domain` (Admin): current revision, resources, rules; complete validated domain replacement with optimistic revision check.
- `PUT /api/constraints` (Admin): confirmed rule replacement.
- `POST /api/timetables/generate` (Admin): server-side generation.
- `GET /api/timetables`, `GET /api/timetables/:id` (Admin/HOD): version list and detail.
- `POST /api/timetables/:id/approve`, `/reject` (HOD): transactional state changes; no client schedule payload accepted.
- `GET /api/timetable/mine` (Teacher/Student): current published schedule scoped to the linked identity.
- `/api/auth/users` and `/api/auth/users/:id/{role,association}` (Admin): account provisioning, role changes, and identity links.
- `POST /api/copilot/interpret` (Admin): language interpretation against the server catalog.

Resource CRUD is currently exposed as a validated atomic `PUT /api/domain` snapshot rather than per-resource REST endpoints. Resource history deletion is constrained by foreign keys. There is no automated legacy timetable importer.

## Legacy data and operations

Old scheduling localStorage keys are preserved; the UI no longer reads them as current state. Admin can export the known keys to `schedulify-legacy-export.json`. Review and manually reconcile resource names/IDs in the export, enter resources through the Admin UI, and generate a fresh candidate. Legacy schedules, approval flags, and old rule confirmations are never imported or trusted automatically.

Set `DATABASE_URL`, run `npm run db:migrate`, then `npm run auth:bootstrap`. Set `COOKIE_SECURE=true` behind HTTPS and `PUBLIC_APP_ORIGIN` to the exact UI origin. A same-origin reverse proxy is the supported deployment topology; keep database and AI credentials only on the API host. `npm test`/`npm run test:unit` cover the local suite. For real PostgreSQL tests, copy `.env.test.example` to `.env.test`, configure a distinct disposable test database, and run `npm run test:db`. The test runner fails if that URL is missing, requires `test` in the database name, checks it differs from `DATABASE_URL`, creates a random isolated schema, runs actual migrations/API transactions, and drops only the schema it created.

`npm run test:e2e` runs Chromium against a real API and an isolated schema in `E2E_DATABASE_URL`; it requires a disposable database ending in `_test` and refuses the configured application database. The browser journey covers Admin setup, missing/malformed Copilot responses, feasible and infeasible generation, stale candidate rejection, HOD rejection and publication, scoped Teacher/Student views, revoked sessions, API outage, and injected database connection failure/recovery. Expired sessions, database readiness failures, and authorization also have unit and PostgreSQL integration coverage. `.github/workflows/ci.yml` runs unit, PostgreSQL integration, E2E, full dependency audit, and build checks with disposable PostgreSQL credentials. The API exposes liveness and database readiness probes, applies request/database timeouts, and closes the pool on termination. The release Compose example keeps PostgreSQL external and routes the web container's `/api` requests to the private API service. The hosted run for pre-fix commit `93edbc3e80b6706485179d97c7c25bcd807bf213` failed in E2E because the Tailwind PostCSS dependency was missing. The correction passed the local verification suite; hosted CI has not yet been rerun for the corrected snapshot.

Backups are an operator responsibility: configure encrypted managed backups/PITR, take a pre-migration restore point, and periodically restore an archive into an isolated database and verify migration/data counts before relying on it. The repository documents a custom-format `pg_dump`/`pg_restore` workflow, but does not configure retention or a provider. The integration suite was executed against a temporary loopback-only PostgreSQL 18.6 cluster; the installed service's application credentials remain unconfigured. The synchronous scheduler has no mid-run cancellation; the API caps node/time budgets. Login throttling remains per API process. The corrected Tailwind snapshot has not yet passed hosted CI, and no live deployment has been verified.
