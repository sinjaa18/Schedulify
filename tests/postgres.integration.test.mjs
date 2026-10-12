import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import bcrypt from "bcryptjs";
import { runMigrations } from "../server/migrate.mjs";
import { createApiServer } from "../server/index.mjs";
import { readDomain, readRules, readTimetable } from "../server/scheduling.mjs";
import { validateTimetable } from "../src/utils/validator.js";
import { ALL_SLOTS } from "../src/utils/domain.js";

const connectionString = process.env.TEST_DATABASE_URL;
const testDatabaseName = (url) => decodeURIComponent(new URL(url).pathname.slice(1));
const comparableDomain = (domain) => ({
  batches: domain.batches.map((batch) => ({ ...batch, requirements: [...batch.requirements].sort((a, b) => a.id.localeCompare(b.id)), availableSlots: [...batch.availableSlots].sort() })),
  subjects: domain.subjects,
  teachers: domain.teachers.map((teacher) => ({ ...teacher, subjectIds: [...teacher.subjectIds].sort(), availableSlots: [...teacher.availableSlots].sort() })),
  rooms: domain.rooms.map((room) => ({ ...room, availableSlots: [...room.availableSlots].sort() })),
});
if (!connectionString) throw new Error("TEST_DATABASE_URL is required for PostgreSQL integration tests; no fake or skipped database path is supported.");

async function waitForDomainRevisionLock(pool, expected) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await pool.query(`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%domain_revision%FOR UPDATE%'`);
    if (result.rows[0].count >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${expected} API request(s) to queue on domain_revision`);
}

test("PostgreSQL HTTP workflow, migrations, isolation, stale approval, and publication concurrency", async () => {
  const target = new URL(connectionString);
  const dbName = testDatabaseName(connectionString);
  const configured = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
  assert.match(dbName.toLowerCase(), /test/, "test database name must contain 'test'");
  assert.ok(!configured || target.pathname !== configured.pathname,
    "TEST_DATABASE_URL must name a different database from DATABASE_URL");

  const administrativePool = new Pool({ connectionString, max: 3, ssl: process.env.TEST_DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined });
  const schema = `schedulify_it_${randomBytes(8).toString("hex")}`;
  let pool; let server; let origin; let previousOrigin; let previousSecure;
  try {
    const identity = await administrativePool.query("SELECT current_database() AS database, current_user AS role, current_setting('server_version_num') AS version");
    assert.equal(identity.rows[0].database, dbName, "connected database must match the explicitly named test database");
    console.info(`PostgreSQL integration server version: ${identity.rows[0].version}`);
    await administrativePool.query(`CREATE SCHEMA "${schema}"`);

    // Every test connection resolves unqualified migration/API tables inside a unique schema.
    const isolatedUrl = new URL(connectionString);
    isolatedUrl.searchParams.set("options", `-c search_path=${schema}`);
    pool = new Pool({ connectionString: isolatedUrl.href, max: 12, ssl: process.env.TEST_DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined });
    await runMigrations(pool);
    const migrationNames = await pool.query("SELECT name FROM schema_migrations ORDER BY name");
    assert.deepEqual(migrationNames.rows.map((row) => row.name), ["001_identity.sql", "002_scheduling_domain.sql"]);
    await runMigrations(pool);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM schema_migrations")).rows[0].count, 2, "migration rerun is idempotent");

    const tableNames = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema=$1", [schema]);
    const tables = new Set(tableNames.rows.map((row) => row.table_name));
    for (const name of ["users", "sessions", "domain_revision", "batches", "subjects", "teachers", "rooms", "batch_requirements", "teacher_subjects", "batch_availability", "teacher_availability", "room_availability", "student_profiles", "confirmed_constraints", "timetable_versions", "timetable_entries", "approval_events"]) assert.ok(tables.has(name), `missing table ${name}`);
    const indexes = await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname=$1", [schema]);
    assert.ok(indexes.rows.some((row) => row.indexname === "timetable_single_publication"));

    const ids = {
      admin: randomUUID(), hod: randomUUID(), teacher1: randomUUID(), teacher2: randomUUID(), student1: randomUUID(), student2: randomUUID(),
      batch1: `batch-${randomUUID()}`, batch2: `batch-${randomUUID()}`, subject: `subject-${randomUUID()}`, subject2: `subject-${randomUUID()}`,
      teacherRecord1: `teacher-${randomUUID()}`, teacherRecord2: `teacher-${randomUUID()}`,
      room1: `room-${randomUUID()}`, room2: `room-${randomUUID()}`,
      requirement1: `requirement-${randomUUID()}`, requirement2: `requirement-${randomUUID()}`,
    };
    const password = "test-password-2026";
    const passwordHash = await bcrypt.hash(password, 4);
    for (const [key, role] of [["admin", "Admin"], ["hod", "HOD"], ["teacher1", "Teacher"], ["teacher2", "Teacher"], ["student1", "Student"], ["student2", "Student"]]) {
      await pool.query("INSERT INTO users(id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5)", [ids[key], key, `${key}@example.test`, passwordHash, role]);
    }

    previousOrigin = process.env.PUBLIC_APP_ORIGIN; previousSecure = process.env.COOKIE_SECURE;
    process.env.COOKIE_SECURE = "false";
    server = createApiServer({ poolProvider: () => pool, interpret: async () => ({ status: 200, body: { summary: "test", rules: [], nextSteps: [] } }) });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    process.env.PUBLIC_APP_ORIGIN = origin;

    const login = async (key) => {
      const response = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email: `${key}@example.test`, password }) });
      assert.equal(response.status, 200, `login for ${key}`);
      return { cookie: response.headers.get("set-cookie").split(";")[0], csrf: (await response.json()).csrfToken };
    };
    const sessions = {};
    for (const key of Object.keys({ admin: 1, hod: 1, teacher1: 1, teacher2: 1, student1: 1, student2: 1 })) sessions[key] = await login(key);
    const call = async (path, { as = "admin", method = "GET", body, csrf = true, query = "" } = {}) => {
      const headers = { origin, cookie: sessions[as].cookie };
      if (csrf && method !== "GET") headers["x-csrf-token"] = sessions[as].csrf;
      if (body !== undefined) headers["content-type"] = "application/json";
      return fetch(`${origin}${path}${query}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    };

    // Admin-controlled identity links, role boundaries, and CSRF failures.
    assert.equal((await call("/api/domain", { method: "PUT", body: { expectedRevision: 0, domain: {} }, csrf: false })).status, 403);

    const domain = {
      batches: [
        { id: ids.batch1, name: "Batch One", requirements: [{ id: ids.requirement1, subjectId: ids.subject, weeklySessions: 1 }], availableSlots: [...ALL_SLOTS] },
        { id: ids.batch2, name: "Batch Two", requirements: [{ id: ids.requirement2, subjectId: ids.subject2, weeklySessions: 1 }], availableSlots: [...ALL_SLOTS] },
      ],
      subjects: [{ id: ids.subject, name: "Mathematics" }, { id: ids.subject2, name: "Physics" }],
      teachers: [
        { id: ids.teacherRecord1, name: "Teacher One", subjectIds: [ids.subject], availableSlots: [...ALL_SLOTS] },
        { id: ids.teacherRecord2, name: "Teacher Two", subjectIds: [ids.subject2], availableSlots: [...ALL_SLOTS] },
      ],
      rooms: [{ id: ids.room1, name: "Room One", availableSlots: [...ALL_SLOTS] }, { id: ids.room2, name: "Room Two", availableSlots: [...ALL_SLOTS] }],
    };
    const before = await (await call("/api/domain")).json();
    const saved = await call("/api/domain", { method: "PUT", body: { expectedRevision: before.revision, domain } });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.equal(savedBody.revision, before.revision + 1);
    assert.deepEqual(comparableDomain(savedBody.domain), comparableDomain(domain));
    const association1 = await call(`/api/auth/users/${ids.teacher1}/association`, { method: "PATCH", body: { teacherId: ids.teacherRecord1 } });
    assert.equal(association1.status, 200);
    sessions.teacher1 = await login("teacher1");
    const association2 = await call(`/api/auth/users/${ids.teacher2}/association`, { method: "PATCH", body: { teacherId: ids.teacherRecord2 } });
    assert.equal(association2.status, 200);
    sessions.teacher2 = await login("teacher2");
    assert.equal((await call(`/api/auth/users/${ids.student1}/association`, { method: "PATCH", body: { batchId: ids.batch1 } })).status, 200);
    sessions.student1 = await login("student1");
    assert.equal((await call(`/api/auth/users/${ids.student2}/association`, { method: "PATCH", body: { batchId: ids.batch2 } })).status, 200);
    sessions.student2 = await login("student2");
    assert.equal((await call(`/api/auth/users/${ids.teacher1}/association`, { method: "PATCH", body: { teacherId: ids.teacherRecord1 }, as: "teacher1" })).status, 403);
    assert.equal((await call(`/api/auth/users/${ids.teacher2}/association`, { method: "PATCH", body: { teacherId: ids.teacherRecord1 } })).status, 409, "a teacher record cannot be linked twice");
    assert.equal((await call("/api/domain", { method: "PUT", body: { expectedRevision: before.revision, domain } })).status, 409, "stale revisions are rejected by the server");
    const malformedDomain = structuredClone(domain); malformedDomain.subjects.push({ ...malformedDomain.subjects[0], id: `subject-${randomUUID()}` });
    assert.equal((await call("/api/domain", { method: "PUT", body: { expectedRevision: savedBody.revision, domain: malformedDomain } })).status, 400);
    const afterInvalid = await (await call("/api/domain")).json();
    assert.equal(afterInvalid.revision, savedBody.revision, "invalid snapshot must not advance the revision");
    assert.deepEqual(comparableDomain(afterInvalid.domain), comparableDomain(domain), "invalid snapshot leaves previously committed data intact");
    assert.equal((await call("/api/domain", { as: "teacher1" })).status, 403);
    assert.equal((await call("/api/domain", { as: "hod" })).status, 200);

    // Recreate the API server; persistent domain, identity links, and sessions remain available.
    await new Promise((resolve) => server.close(resolve));
    server = createApiServer({ poolProvider: () => pool, interpret: async () => ({ status: 200, body: { summary: "test", rules: [], nextSteps: [] } }) });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${server.address().port}`; process.env.PUBLIC_APP_ORIGIN = origin;
    const reopened = await (await call("/api/domain")).json();
    assert.equal(reopened.revision, savedBody.revision);
    assert.deepEqual(comparableDomain(reopened.domain), comparableDomain(domain));
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM student_profiles WHERE user_id=ANY($1::uuid[])", [[ids.student1, ids.student2]])).rows[0].count, 2);

    const hardRule = { type: "keep_day_free", priority: "hard", batch: "Batch One", teacher: null, subject: null, room: null, day: "Fri", period: null, explanation: "Keep Batch One free Friday", validation: "ready", clarification: null };
    const ruleResponse = await call("/api/constraints", { method: "PUT", body: { expectedRevision: afterInvalid.revision, rules: [hardRule] } });
    assert.equal(ruleResponse.status, 200);
    const ruleBody = await ruleResponse.json();
    assert.equal(ruleBody.revision, afterInvalid.revision + 1);
    assert.equal(ruleBody.rules[0].confirmedBy, ids.admin);

    const versionsBeforeBudget = (await pool.query("SELECT count(*)::int AS count FROM timetable_versions")).rows[0].count;
    const limited = await call("/api/timetables/generate", { method: "POST", body: { maxNodes: 1 } });
    assert.equal(limited.status, 422); assert.equal((await limited.json()).status, "search_limit");
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM timetable_versions")).rows[0].count, versionsBeforeBudget);

    // Generation is canonical, persisted atomically, and checked independently after DB readback.
    const generated = await call("/api/timetables/generate", { method: "POST", body: {} });
    assert.equal(generated.status, 201);
    const generatedBody = await generated.json(); const candidateId = generatedBody.version.id;
    assert.equal(generatedBody.ok, true);
    assert.equal(generatedBody.validation.valid, true);
    const persisted = await readTimetable(pool, candidateId);
    assert.equal(persisted.status, "candidate");
    assert.equal(persisted.timetable.length, 2);
    const storedDomain = await readDomain(pool); const storedRules = await readRules(pool);
    const independentlyChecked = validateTimetable(persisted.timetable, storedDomain, { rules: storedRules });
    assert.equal(independentlyChecked.valid, true);
    assert.ok(persisted.timetable.every((row) => row.day !== "Fri"), "confirmed hard rule is applied");
    const conflicts = await pool.query(`SELECT count(*)::int AS count FROM (
      SELECT batch_id,day,slot FROM timetable_entries WHERE version_id=$1 GROUP BY batch_id,day,slot HAVING count(*)>1
      UNION ALL SELECT teacher_id,day,slot FROM timetable_entries WHERE version_id=$1 GROUP BY teacher_id,day,slot HAVING count(*)>1
      UNION ALL SELECT room_id,day,slot FROM timetable_entries WHERE version_id=$1 GROUP BY room_id,day,slot HAVING count(*)>1
    ) c`, [candidateId]);
    assert.equal(conflicts.rows[0].count, 0);
    const firstEntry = persisted.timetable[0];
    await assert.rejects(pool.query(`INSERT INTO timetable_entries(version_id,id,batch_id,subject_id,teacher_id,room_id,requirement_id,day,slot,batch_name,subject_name,teacher_name,room_name)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [candidateId, `duplicate-${randomUUID()}`, firstEntry.batchId, firstEntry.subjectId, firstEntry.teacherId, firstEntry.roomId, firstEntry.requirementId, firstEntry.day, firstEntry.slot, firstEntry.batch, firstEntry.subject, firstEntry.teacher, firstEntry.room]), { code: "23505" });

    // HOD-only publication records actor and history.
    assert.equal((await call(`/api/timetables/${candidateId}/approve`, { method: "POST", as: "admin" })).status, 403);
    const published = await call(`/api/timetables/${candidateId}/approve`, { method: "POST", as: "hod" });
    assert.equal(published.status, 200);
    const publishedBody = await published.json();
    assert.equal(publishedBody.status, "approved"); assert.equal(publishedBody.approvedBy, ids.hod); assert.ok(publishedBody.approvedAt);
    assert.equal((await call(`/api/timetables/${candidateId}/approve`, { method: "POST", as: "hod" })).status, 409, "double approval is rejected");
    // Scoped views ignore forged query identifiers and only expose the published timetable.
    const ownTeacher = await (await call("/api/timetable/mine", { as: "teacher1", query: `?teacherId=${ids.teacherRecord2}` })).json();
    assert.deepEqual(new Set(ownTeacher.timetable.map((row) => row.teacherId)), new Set([ids.teacherRecord1]));
    const ownStudent = await (await call("/api/timetable/mine", { as: "student1", query: `?batchId=${ids.batch2}` })).json();
    assert.deepEqual(new Set(ownStudent.timetable.map((row) => row.batchId)), new Set([ids.batch1]));

    const corruptedId = (await (await call("/api/timetables/generate", { method: "POST", body: {} })).json()).version.id;
    await pool.query("UPDATE timetable_entries SET day='Fri' WHERE version_id=$1 AND batch_id=$2", [corruptedId, ids.batch1]);
    assert.equal((await call(`/api/timetables/${corruptedId}/approve`, { method: "POST", as: "hod" })).status, 409,
      "approval revalidates the stored entries instead of trusting generation-time results");
    assert.equal((await pool.query("SELECT status FROM timetable_versions WHERE id=$1", [corruptedId])).rows[0].status, "rejected");
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM timetable_versions WHERE status='approved'")).rows[0].count, 1,
      "failed revalidation leaves the existing publication unchanged");

    const rejectedCandidate = (await (await call("/api/timetables/generate", { method: "POST", body: {} })).json()).version.id;
    assert.equal((await call(`/api/timetables/${rejectedCandidate}/reject`, { method: "POST", as: "hod" })).status, 200);
    assert.equal((await call(`/api/timetables/${rejectedCandidate}/approve`, { method: "POST", as: "hod" })).status, 409, "rejected candidates cannot be approved");

    // Same-candidate simultaneous approval has one successful transition; competing publications serialize.
    const candidateTwoResponse = await call("/api/timetables/generate", { method: "POST", body: {} });
    const candidateTwo = (await candidateTwoResponse.json()).version.id;
    const duplicateApproval = await Promise.all([
      call(`/api/timetables/${candidateTwo}/approve`, { method: "POST", as: "hod" }),
      call(`/api/timetables/${candidateTwo}/approve`, { method: "POST", as: "hod" }),
    ]);
    assert.deepEqual(duplicateApproval.map((response) => response.status).sort(), [200, 409]);
    const candidateThree = (await (await call("/api/timetables/generate", { method: "POST", body: {} })).json()).version.id;
    const candidateFour = (await (await call("/api/timetables/generate", { method: "POST", body: {} })).json()).version.id;
    const competing = await Promise.all([
      call(`/api/timetables/${candidateThree}/approve`, { method: "POST", as: "hod" }),
      call(`/api/timetables/${candidateFour}/approve`, { method: "POST", as: "hod" }),
    ]);
    assert.deepEqual(competing.map((response) => response.status), [200, 200]);
    const current = await pool.query("SELECT id,status,source_revision FROM timetable_versions WHERE status='approved'");
    assert.equal(current.rowCount, 1, "only one publication remains current after concurrent approvals");
    const previousPublicationId = current.rows[0].id;
    const historical = await pool.query("SELECT status FROM timetable_versions WHERE id=$1", [candidateTwo]);
    assert.ok(["approved", "superseded"].includes(historical.rows[0].status));

    // A resource update invalidates candidate and publication; stale approval cannot publish.
    const staleCandidate = (await (await call("/api/timetables/generate", { method: "POST", body: {} })).json()).version.id;
    const freshDomain = structuredClone(domain); freshDomain.rooms[0].name = "Room One Updated";
    const currentRevision = (await (await call("/api/domain")).json()).revision;
    const changed = await call("/api/domain", { method: "PUT", body: { expectedRevision: currentRevision, domain: freshDomain } });
    assert.equal(changed.status, 200);
    assert.equal((await call(`/api/timetables/${staleCandidate}/approve`, { method: "POST", as: "hod" })).status, 409);
    const staleRow = await pool.query("SELECT status FROM timetable_versions WHERE id=$1", [staleCandidate]);
    assert.equal(staleRow.rows[0].status, "stale");
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM timetable_versions WHERE status='approved'")).rows[0].count, 0,
      "documented policy marks the prior publication stale when any scheduler input changes");
    assert.equal((await pool.query("SELECT status FROM timetable_versions WHERE id=$1", [previousPublicationId])).rows[0].status, "stale",
      "prior publication remains in version history after invalidation");

    const newCandidate = (await (await call("/api/timetables/generate", { method: "POST", body: {} })).json()).version.id;
    assert.equal((await call(`/api/timetables/${newCandidate}/approve`, { method: "POST", as: "hod" })).status, 200);

    // Hold the revision row, queue a domain update before approval, and release both using PostgreSQL wait-state synchronization.
    const raceCandidate = (await (await call("/api/timetables/generate", { method: "POST", body: {} })).json()).version.id;
    const revisionForRace = (await (await call("/api/domain")).json()).revision;
    const raceDomain = structuredClone(freshDomain); raceDomain.rooms[0].name = "Room One Race Update";
    const lockHolder = await pool.connect();
    try {
      await lockHolder.query("BEGIN");
      await lockHolder.query("SELECT revision FROM domain_revision WHERE singleton=1 FOR UPDATE");
      const updateRequest = call("/api/domain", { method: "PUT", body: { expectedRevision: revisionForRace, domain: raceDomain } });
      await waitForDomainRevisionLock(pool, 1);
      const approvalRequest = call(`/api/timetables/${raceCandidate}/approve`, { method: "POST", as: "hod" });
      await waitForDomainRevisionLock(pool, 2);
      await lockHolder.query("COMMIT");
      assert.equal((await updateRequest).status, 200);
      assert.equal((await approvalRequest).status, 409, "queued approval observes the committed newer revision");
    } finally {
      try { await lockHolder.query("ROLLBACK"); } catch { /* transaction already committed */ }
      lockHolder.release();
    }
    assert.equal((await pool.query("SELECT status FROM timetable_versions WHERE id=$1", [raceCandidate])).rows[0].status, "stale");

    const freshAfterRace = (await (await call("/api/timetables/generate", { method: "POST", body: {} })).json()).version.id;
    assert.equal((await call(`/api/timetables/${freshAfterRace}/approve`, { method: "POST", as: "hod" })).status, 200);

    // Infeasibility returns a distinct failure and creates no version or partial entries.
    const latest = (await (await call("/api/domain")).json());
    const impossible = structuredClone(freshDomain); impossible.teachers.forEach((teacher) => { teacher.subjectIds = []; });
    assert.equal((await call("/api/domain", { method: "PUT", body: { expectedRevision: latest.revision, domain: impossible } })).status, 200);
    const versionsBeforeFailure = await pool.query("SELECT count(*)::int AS count FROM timetable_versions");
    const failed = await call("/api/timetables/generate", { method: "POST", body: {} });
    assert.equal(failed.status, 422); assert.equal((await failed.json()).status, "infeasible");
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM timetable_versions")).rows[0].count, versionsBeforeFailure.rows[0].count);

    const invalidInput = structuredClone(freshDomain); invalidInput.batches.forEach((batch) => { batch.requirements = []; });
    const noRequirementsRevision = (await (await call("/api/domain")).json()).revision;
    assert.equal((await call("/api/domain", { method: "PUT", body: { expectedRevision: noRequirementsRevision, domain: invalidInput } })).status, 200);
    const invalidGeneration = await call("/api/timetables/generate", { method: "POST", body: {} });
    assert.equal(invalidGeneration.status, 422); assert.equal((await invalidGeneration.json()).status, "invalid_input");

    // Session revocation and disabled-account checks remain enforced over the real store.
    const changedRole = await call(`/api/auth/users/${ids.student2}/role`, { method: "PATCH", body: { role: "Teacher" } });
    assert.equal(changedRole.status, 200);
    assert.equal((await call("/api/timetable/mine", { as: "student2" })).status, 401, "role changes revoke existing sessions");
    await pool.query("UPDATE users SET status='disabled' WHERE id=$1", [ids.teacher2]);
    assert.equal((await call("/api/timetable/mine", { as: "teacher2" })).status, 401, "disabled accounts cannot use active sessions");

    // Simulated mid-write database failure proves version and entry persistence roll back together.
    const triggerFn = `fail_entry_${randomBytes(6).toString("hex")}`;
    await pool.query(`CREATE FUNCTION ${triggerFn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected integration failure'; END $$`);
    await pool.query(`CREATE TRIGGER fail_timetable_entry BEFORE INSERT ON timetable_entries FOR EACH ROW EXECUTE FUNCTION ${triggerFn}()`);
    // Restore a feasible domain before exercising the failed candidate transaction.
    const failedDomainRev = (await (await call("/api/domain")).json()).revision;
    await call("/api/domain", { method: "PUT", body: { expectedRevision: failedDomainRev, domain: freshDomain } });
    const versionCount = (await pool.query("SELECT count(*)::int AS count FROM timetable_versions")).rows[0].count;
    const internalFailure = await call("/api/timetables/generate", { method: "POST", body: {} });
    assert.equal(internalFailure.status, 503);
    assert.equal((await internalFailure.text()).includes("injected integration failure"), false, "database details must not be disclosed");
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM timetable_versions")).rows[0].count, versionCount, "failed entry insert rolls back version insert");
    await pool.query("DROP TRIGGER fail_timetable_entry ON timetable_entries");
    await pool.query(`DROP FUNCTION ${triggerFn}()`);

    // Constraint checks: foreign keys and database uniqueness are exercised directly.
    await assert.rejects(pool.query("INSERT INTO batch_requirements(id,batch_id,subject_id,weekly_sessions) VALUES($1,$2,$3,1)", [`bad-${randomUUID()}`, ids.batch1, `missing-${randomUUID()}`]), { code: "23503" });
    const linkedDuplicate = await pool.query("SELECT count(*)::int AS count FROM teachers WHERE user_id=$1", [ids.teacher1]);
    assert.equal(linkedDuplicate.rows[0].count, 1);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    // Only this test's randomly named schema is removed; no table-wide cleanup is used.
    await administrativePool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await administrativePool.end();
    if (previousOrigin === undefined) delete process.env.PUBLIC_APP_ORIGIN; else process.env.PUBLIC_APP_ORIGIN = previousOrigin;
    if (previousSecure === undefined) delete process.env.COOKIE_SECURE; else process.env.COOKIE_SECURE = previousSecure;
  }
});

test("migration 002 fails clearly if the identity prerequisite is absent", async () => {
  const target = new URL(connectionString);
  const dbName = testDatabaseName(connectionString);
  const configured = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
  assert.match(dbName.toLowerCase(), /test/, "test database name must contain 'test'");
  assert.ok(!configured || target.pathname !== configured.pathname,
    "TEST_DATABASE_URL must name a different database from DATABASE_URL");
  const pool = new Pool({ connectionString, max: 2, ssl: process.env.TEST_DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined });
  const schema = `schedulify_prereq_${randomBytes(8).toString("hex")}`;
  try {
    const identity = await pool.query("SELECT current_database() AS database");
    assert.equal(identity.rows[0].database, dbName);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const isolatedUrl = new URL(connectionString); isolatedUrl.searchParams.set("options", `-c search_path=${schema}`);
    const isolated = new Pool({ connectionString: isolatedUrl.href, max: 1, ssl: process.env.TEST_DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined });
    try {
      const sql = await readFile(new URL("../server/migrations/002_scheduling_domain.sql", import.meta.url), "utf8");
      await assert.rejects(isolated.query(sql), (error) => error.code === "42P01");
    } finally { await isolated.end(); }
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});
