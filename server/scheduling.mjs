import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ALL_SLOTS } from "../src/utils/domain.js";
import { validateTimetable } from "../src/utils/validator.js";
import { generateTimetable } from "../src/utils/scheduler.js";
import { ruleSchema, validateReferences } from "./copilot-schema.mjs";

const idSchema = z.string().trim().min(1).max(128);
const availabilitySchema = z.array(z.enum(ALL_SLOTS)).max(25);
const subjectSchema = z.object({ id: idSchema, name: z.string().trim().min(1).max(100), minPerWeek: z.number().int().min(1).max(25).optional() }).strict();
const teacherSchema = z.object({ id: idSchema, name: z.string().trim().min(1).max(100), subjectIds: z.array(idSchema).max(200), availableSlots: availabilitySchema }).strict();
const roomSchema = z.object({ id: idSchema, name: z.string().trim().min(1).max(100), availableSlots: availabilitySchema }).strict();
const requirementSchema = z.object({ id: idSchema, subjectId: idSchema, weeklySessions: z.number().int().min(1).max(25) }).strict();
const batchSchema = z.object({ id: idSchema, name: z.string().trim().min(1).max(100), requirements: z.array(requirementSchema).max(200), availableSlots: availabilitySchema }).strict();
export const domainSchema = z.object({
  batches: z.array(batchSchema).max(200), subjects: z.array(subjectSchema).max(200),
  teachers: z.array(teacherSchema).max(200), rooms: z.array(roomSchema).max(200),
}).strict();
const revisionSchema = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]).transform(Number);

export class SchedulingError extends Error {
  constructor(status, code, message, details = {}) { super(message); this.status = status; this.code = code; this.details = details; }
}

function assertUnique(items, label, byName = false) {
  const seen = new Set();
  for (const item of items) {
    const value = byName ? item.name.toLocaleLowerCase("en") : item.id;
    if (seen.has(value)) throw new SchedulingError(400, "duplicate_resource", `Duplicate ${label} ${byName ? "name" : "ID"}.`);
    seen.add(value);
  }
  return seen;
}

function validateDomain(input) {
  const parsed = domainSchema.safeParse(input);
  if (!parsed.success) throw new SchedulingError(400, "invalid_domain", "The scheduling domain is malformed.", { issues: parsed.error.issues.map(({ path, message }) => ({ path, message })) });
  const domain = parsed.data;
  const batchIds = assertUnique(domain.batches, "batch"); assertUnique(domain.batches, "batch", true);
  const subjectIds = assertUnique(domain.subjects, "subject"); assertUnique(domain.subjects, "subject", true);
  const teacherIds = assertUnique(domain.teachers, "teacher"); assertUnique(domain.teachers, "teacher", true);
  assertUnique(domain.rooms, "room"); assertUnique(domain.rooms, "room", true);
  const requirementIds = new Set();
  for (const batch of domain.batches) {
    for (const requirement of batch.requirements) {
      if (requirementIds.has(requirement.id)) throw new SchedulingError(400, "duplicate_requirement", "Requirement IDs must be unique.");
      requirementIds.add(requirement.id);
      if (!subjectIds.has(requirement.subjectId)) throw new SchedulingError(400, "invalid_reference", `Batch ${batch.name} references an unknown subject.`, { batchId: batch.id, subjectId: requirement.subjectId });
    }
  }
  for (const teacher of domain.teachers) {
    if (new Set(teacher.subjectIds).size !== teacher.subjectIds.length) throw new SchedulingError(400, "duplicate_eligibility", `Teacher ${teacher.name} has duplicate subject eligibility.`);
    if (teacher.subjectIds.some((id) => !subjectIds.has(id))) throw new SchedulingError(400, "invalid_reference", `Teacher ${teacher.name} references an unknown subject.`);
  }
  for (const batch of domain.batches) if (new Set(batch.availableSlots).size !== batch.availableSlots.length) throw new SchedulingError(400, "duplicate_availability", `Batch ${batch.name} has duplicate availability slots.`);
  for (const teacher of domain.teachers) if (new Set(teacher.availableSlots).size !== teacher.availableSlots.length) throw new SchedulingError(400, "duplicate_availability", `Teacher ${teacher.name} has duplicate availability slots.`);
  for (const room of domain.rooms) if (new Set(room.availableSlots).size !== room.availableSlots.length) throw new SchedulingError(400, "duplicate_availability", `Room ${room.name} has duplicate availability slots.`);
  return domain;
}

async function revisionOf(db, lock = false) {
  const result = await db.query(`SELECT revision FROM domain_revision WHERE singleton=1${lock ? " FOR UPDATE" : ""}`);
  if (!result.rowCount) throw new SchedulingError(503, "not_migrated", "Scheduling database migrations have not been applied.");
  return Number(result.rows[0].revision);
}

export async function readDomain(db) {
  // The same function is called with both a Pool and a transaction-bound Client.
  // Sequence reads so the latter never has overlapping client.query() operations.
  const batchRows = await db.query("SELECT id,name FROM batches ORDER BY sort_order,id");
  const subjectRows = await db.query("SELECT id,name,legacy_min_per_week FROM subjects ORDER BY sort_order,id");
  const teacherRows = await db.query("SELECT id,name FROM teachers ORDER BY sort_order,id");
  const roomRows = await db.query("SELECT id,name FROM rooms ORDER BY sort_order,id");
  const requirementRows = await db.query("SELECT id,batch_id,subject_id,weekly_sessions FROM batch_requirements ORDER BY batch_id,sort_order,id");
  const eligibilityRows = await db.query("SELECT teacher_id,subject_id FROM teacher_subjects ORDER BY teacher_id,subject_id");
  const availabilityRows = await db.query(`SELECT 'batch' AS kind,batch_id AS resource_id,day,slot FROM batch_availability
    UNION ALL SELECT 'teacher',teacher_id,day,slot FROM teacher_availability
    UNION ALL SELECT 'room',room_id,day,slot FROM room_availability`);
  const byResource = { batch: new Map(), teacher: new Map(), room: new Map() };
  for (const row of availabilityRows.rows) {
    const map = byResource[row.kind];
    if (!map.has(row.resource_id)) map.set(row.resource_id, []);
    map.get(row.resource_id).push(`${row.day}|${row.slot}`);
  }
  const requirements = new Map();
  for (const row of requirementRows.rows) {
    if (!requirements.has(row.batch_id)) requirements.set(row.batch_id, []);
    requirements.get(row.batch_id).push({ id: row.id, subjectId: row.subject_id, weeklySessions: row.weekly_sessions });
  }
  const subjectIds = new Map();
  for (const row of eligibilityRows.rows) {
    if (!subjectIds.has(row.teacher_id)) subjectIds.set(row.teacher_id, []);
    subjectIds.get(row.teacher_id).push(row.subject_id);
  }
  return {
    batches: batchRows.rows.map((row) => ({ id: row.id, name: row.name, requirements: requirements.get(row.id) || [], availableSlots: byResource.batch.get(row.id) || [] })),
    subjects: subjectRows.rows.map((row) => ({ id: row.id, name: row.name, ...(row.legacy_min_per_week == null ? {} : { minPerWeek: row.legacy_min_per_week }) })),
    teachers: teacherRows.rows.map((row) => ({ id: row.id, name: row.name, subjectIds: subjectIds.get(row.id) || [], availableSlots: byResource.teacher.get(row.id) || [] })),
    rooms: roomRows.rows.map((row) => ({ id: row.id, name: row.name, availableSlots: byResource.room.get(row.id) || [] })),
  };
}

export async function readRules(db) {
  const result = await db.query("SELECT id,rule,confirmed_by,confirmed_at FROM confirmed_constraints ORDER BY confirmed_at,id");
  return result.rows.map((row) => ({ ...row.rule, id: row.id, confirmedBy: row.confirmed_by, confirmedAt: row.confirmed_at }));
}

async function invalidateTimetables(client, actorId, oldRevision) {
  const stale = await client.query("UPDATE timetable_versions SET status='stale' WHERE status IN ('candidate','approved') RETURNING id");
  for (const row of stale.rows) await client.query("INSERT INTO approval_events(id,version_id,actor_id,action,source_revision,details) VALUES($1,$2,$3,'stale',$4,$5::jsonb)", [randomUUID(), row.id, actorId, oldRevision, JSON.stringify({ reason: "scheduling_domain_changed" })]);
}

export async function saveDomain(pool, { expectedRevision, domain: input }, actorId) {
  const expected = revisionSchema.safeParse(expectedRevision);
  if (!expected.success) throw new SchedulingError(400, "invalid_revision", "A valid scheduling revision is required.");
  const domain = validateDomain(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await revisionOf(client, true);
    if (current !== expected.data) throw new SchedulingError(409, "revision_conflict", "Scheduling data changed since it was loaded. Reload before saving.", { currentRevision: current });
    const ids = {
      batches: domain.batches.map((item) => item.id), subjects: domain.subjects.map((item) => item.id),
      teachers: domain.teachers.map((item) => item.id), rooms: domain.rooms.map((item) => item.id),
    };
    const linkedTeachers = await client.query("SELECT id FROM teachers WHERE user_id IS NOT NULL");
    if (linkedTeachers.rows.some((row) => !ids.teachers.includes(row.id))) throw new SchedulingError(409, "linked_teacher", "Unlink the teacher account before removing its teacher record.");
    const oldRevision = current;
    for (const [index, item] of domain.subjects.entries()) await client.query(`INSERT INTO subjects(id,name,legacy_min_per_week,sort_order) VALUES($1,$2,$3,$4)
      ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,legacy_min_per_week=EXCLUDED.legacy_min_per_week,sort_order=EXCLUDED.sort_order`, [item.id, item.name, item.minPerWeek ?? null, index]);
    for (const [index, item] of domain.batches.entries()) await client.query(`INSERT INTO batches(id,name,sort_order) VALUES($1,$2,$3)
      ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,sort_order=EXCLUDED.sort_order`, [item.id, item.name, index]);
    for (const [index, item] of domain.teachers.entries()) await client.query(`INSERT INTO teachers(id,name,sort_order) VALUES($1,$2,$3)
      ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,sort_order=EXCLUDED.sort_order`, [item.id, item.name, index]);
    for (const [index, item] of domain.rooms.entries()) await client.query(`INSERT INTO rooms(id,name,sort_order) VALUES($1,$2,$3)
      ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,sort_order=EXCLUDED.sort_order`, [item.id, item.name, index]);

    const requirements = domain.batches.flatMap((batch) => batch.requirements.map((item, index) => ({ ...item, batchId: batch.id, sortOrder: index })));
    for (const item of requirements) await client.query(`INSERT INTO batch_requirements(id,batch_id,subject_id,weekly_sessions,sort_order) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(id) DO UPDATE SET batch_id=EXCLUDED.batch_id,subject_id=EXCLUDED.subject_id,weekly_sessions=EXCLUDED.weekly_sessions,sort_order=EXCLUDED.sort_order`, [item.id, item.batchId, item.subjectId, item.weeklySessions, item.sortOrder]);
    await client.query("DELETE FROM teacher_subjects");
    for (const teacher of domain.teachers) for (const subjectId of teacher.subjectIds) await client.query("INSERT INTO teacher_subjects(teacher_id,subject_id) VALUES($1,$2)", [teacher.id, subjectId]);
    await client.query("DELETE FROM batch_availability"); await client.query("DELETE FROM teacher_availability"); await client.query("DELETE FROM room_availability");
    for (const batch of domain.batches) for (const value of batch.availableSlots) { const [day, slot] = value.split("|"); await client.query("INSERT INTO batch_availability(batch_id,day,slot) VALUES($1,$2,$3)", [batch.id, day, slot]); }
    for (const teacher of domain.teachers) for (const value of teacher.availableSlots) { const [day, slot] = value.split("|"); await client.query("INSERT INTO teacher_availability(teacher_id,day,slot) VALUES($1,$2,$3)", [teacher.id, day, slot]); }
    for (const room of domain.rooms) for (const value of room.availableSlots) { const [day, slot] = value.split("|"); await client.query("INSERT INTO room_availability(room_id,day,slot) VALUES($1,$2,$3)", [room.id, day, slot]); }

    await client.query("DELETE FROM batch_requirements WHERE NOT (id = ANY($1::text[]))", [requirements.map((item) => item.id)]);
    await client.query("DELETE FROM batches WHERE NOT (id = ANY($1::text[]))", [ids.batches]);
    await client.query("DELETE FROM teachers WHERE NOT (id = ANY($1::text[]))", [ids.teachers]);
    await client.query("DELETE FROM subjects WHERE NOT (id = ANY($1::text[]))", [ids.subjects]);
    await client.query("DELETE FROM rooms WHERE NOT (id = ANY($1::text[]))", [ids.rooms]);

    await invalidateTimetables(client, actorId, oldRevision);
    const next = await client.query("UPDATE domain_revision SET revision=revision+1,updated_at=now() WHERE singleton=1 RETURNING revision");
    const savedDomain = await readDomain(client);
    await client.query("COMMIT");
    return { revision: Number(next.rows[0].revision), domain: savedDomain };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function replaceRules(pool, { expectedRevision, rules: input }, actorId) {
  const expected = revisionSchema.safeParse(expectedRevision);
  const cleanRules = Array.isArray(input) ? input.map((rule) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) return rule;
    const { id, confirmedBy, confirmedAt, ...value } = rule; return value;
  }) : input;
  const parsed = z.array(ruleSchema).max(100).safeParse(cleanRules);
  if (!expected.success || !parsed.success) throw new SchedulingError(400, "invalid_constraints", "Provide a valid revision and scheduling constraint list.");
  const domain = await readDomain(pool);
  const checked = validateReferences({ summary: "Confirmed requirements", rules: parsed.data, nextSteps: [] }, {
    batches: domain.batches.map((item) => item.name), teachers: domain.teachers.map((item) => item.name), subjects: domain.subjects.map((item) => item.name), rooms: domain.rooms.map((item) => item.name),
  });
  if (checked.errors.length) throw new SchedulingError(400, "invalid_constraint_reference", "One or more constraints reference unknown resources.", { errors: checked.errors });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await revisionOf(client, true);
    if (current !== expected.data) throw new SchedulingError(409, "revision_conflict", "Scheduling data changed since it was loaded. Reload before saving.", { currentRevision: current });
    await client.query("DELETE FROM confirmed_constraints");
    for (const rule of checked.result.rules) await client.query("INSERT INTO confirmed_constraints(id,rule,confirmed_by,confirmed_revision) VALUES($1,$2::jsonb,$3,$4)", [randomUUID(), JSON.stringify(rule), actorId, current + 1]);
    await invalidateTimetables(client, actorId, current);
    const next = await client.query("UPDATE domain_revision SET revision=revision+1,updated_at=now() WHERE singleton=1 RETURNING revision");
    const savedRules = await readRules(client);
    await client.query("COMMIT");
    return { revision: Number(next.rows[0].revision), rules: savedRules };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function readRevision(db) { return revisionOf(db); }

export async function generateCandidate(pool, actorId, { maxNodes = 25_000, maxDurationMs = 10_000 } = {}) {
  const snapshot = await pool.connect();
  let revision; let domain; let rules;
  try {
    await snapshot.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    revision = await revisionOf(snapshot);
    domain = await readDomain(snapshot);
    rules = await readRules(snapshot);
    await snapshot.query("COMMIT");
  } catch (error) { await snapshot.query("ROLLBACK"); throw error; }
  finally { snapshot.release(); }

  const result = generateTimetable(domain, { rules, maxNodes, maxDurationMs });
  if (!result.ok) return { ...result, sourceRevision: revision };
  const validation = validateTimetable(result.timetable, domain, { rules });
  if (!validation.valid) return { ok: false, status: "invalid_candidate", timetable: [], diagnostics: validation.violations, sourceRevision: revision, stats: result.stats };

  const client = await pool.connect();
  const versionId = randomUUID();
  try {
    await client.query("BEGIN");
    const current = await revisionOf(client, true);
    if (current !== revision) throw new SchedulingError(409, "revision_conflict", "Scheduling data changed during generation. Generate a new candidate from current data.", { currentRevision: current });
    await client.query(`INSERT INTO timetable_versions(id,status,source_revision,created_by,validated_at,validation,diagnostics,stats)
      VALUES($1,'candidate',$2,$3,now(),$4::jsonb,$5::jsonb,$6::jsonb)`, [versionId, revision, actorId, JSON.stringify(validation), JSON.stringify(result.diagnostics), JSON.stringify(result.stats)]);
    for (const row of result.timetable) await client.query(`INSERT INTO timetable_entries(version_id,id,batch_id,subject_id,teacher_id,room_id,requirement_id,day,slot,batch_name,subject_name,teacher_name,room_name)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [versionId, row.id, row.batchId, row.subjectId, row.teacherId, row.roomId, row.requirementId, row.day, row.slot, row.batch, row.subject, row.teacher, row.room]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  return { ...result, validation, version: { id: versionId, status: "candidate", sourceRevision: revision } };
}

function mapEntry(row) {
  return { id: row.id, batchId: row.batch_id, subjectId: row.subject_id, teacherId: row.teacher_id, roomId: row.room_id, requirementId: row.requirement_id,
    day: row.day, slot: row.slot, batch: row.batch_name, subject: row.subject_name, teacher: row.teacher_name, room: row.room_name };
}
export async function readTimetable(db, versionId) {
  const version = await db.query("SELECT * FROM timetable_versions WHERE id=$1", [versionId]);
  if (!version.rowCount) return null;
  const entries = await db.query("SELECT * FROM timetable_entries WHERE version_id=$1 ORDER BY day,slot,batch_id", [versionId]);
  const row = version.rows[0];
  return { id: row.id, status: row.status, sourceRevision: Number(row.source_revision), createdBy: row.created_by, createdAt: row.created_at,
    validatedAt: row.validated_at, validation: row.validation, diagnostics: row.diagnostics, stats: row.stats,
    approvedBy: row.approved_by, approvedAt: row.approved_at, timetable: entries.rows.map(mapEntry) };
}

export async function listTimetables(db) {
  const rows = await db.query(`SELECT id,status,source_revision,created_by,created_at,validated_at,approved_by,approved_at,validation,diagnostics,stats
    FROM timetable_versions ORDER BY created_at DESC LIMIT 100`);
  return rows.rows.map((row) => ({ id: row.id, status: row.status, sourceRevision: Number(row.source_revision), createdBy: row.created_by,
    createdAt: row.created_at, validatedAt: row.validated_at, approvedBy: row.approved_by, approvedAt: row.approved_at,
    validation: row.validation, diagnostics: row.diagnostics, stats: row.stats }));
}

export async function approveTimetable(pool, versionId, actorId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const revision = await revisionOf(client, true);
    const found = await client.query("SELECT * FROM timetable_versions WHERE id=$1 FOR UPDATE", [versionId]);
    if (!found.rowCount) throw new SchedulingError(404, "not_found", "Timetable version not found.");
    const version = found.rows[0];
    if (version.status !== "candidate") throw new SchedulingError(409, "invalid_transition", "Only a pending candidate can be approved.", { status: version.status });
    if (Number(version.source_revision) !== revision) {
      await client.query("UPDATE timetable_versions SET status='stale' WHERE id=$1", [versionId]);
      await client.query("INSERT INTO approval_events(id,version_id,actor_id,action,source_revision,details) VALUES($1,$2,$3,'stale',$4,$5::jsonb)", [randomUUID(), versionId, actorId, Number(version.source_revision), JSON.stringify({ currentRevision: revision })]);
      await client.query("COMMIT");
      throw new SchedulingError(409, "stale_candidate", "This candidate was generated from older scheduling data and must be regenerated.", { currentRevision: revision });
    }
    const domain = await readDomain(client); const rules = await readRules(client);
    const entries = await client.query("SELECT * FROM timetable_entries WHERE version_id=$1 ORDER BY day,slot,batch_id", [versionId]);
    const timetable = entries.rows.map(mapEntry);
    const validation = validateTimetable(timetable, domain, { rules });
    if (!validation.valid) {
      await client.query("UPDATE timetable_versions SET status='rejected',validation=$2::jsonb WHERE id=$1", [versionId, JSON.stringify(validation)]);
      await client.query("INSERT INTO approval_events(id,version_id,actor_id,action,source_revision,details) VALUES($1,$2,$3,'approval_revalidation_failed',$4,$5::jsonb)", [randomUUID(), versionId, actorId, revision, JSON.stringify({ violations: validation.violations })]);
      await client.query("COMMIT");
      throw new SchedulingError(409, "validation_failed", "The stored timetable no longer passes independent validation.", { violations: validation.violations });
    }
    await client.query("UPDATE timetable_versions SET status='superseded' WHERE status='approved'");
    await client.query("UPDATE timetable_versions SET status='approved',approved_by=$2,approved_at=now(),validation=$3::jsonb WHERE id=$1", [versionId, actorId, JSON.stringify(validation)]);
    await client.query("INSERT INTO approval_events(id,version_id,actor_id,action,source_revision,details) VALUES($1,$2,$3,'approved',$4,$5::jsonb)", [randomUUID(), versionId, actorId, revision, JSON.stringify({ violations: 0 })]);
    const published = await readTimetable(client, versionId);
    await client.query("COMMIT");
    return published;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* already committed for auditable rejections */ }
    throw error;
  } finally { client.release(); }
}

export async function rejectTimetable(pool, versionId, actorId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const revision = await revisionOf(client, true);
    const found = await client.query("SELECT status,source_revision FROM timetable_versions WHERE id=$1 FOR UPDATE", [versionId]);
    if (!found.rowCount) throw new SchedulingError(404, "not_found", "Timetable version not found.");
    if (found.rows[0].status !== "candidate") throw new SchedulingError(409, "invalid_transition", "Only a pending candidate can be rejected.");
    await client.query("UPDATE timetable_versions SET status='rejected',rejected_by=$2,rejected_at=now() WHERE id=$1", [versionId, actorId]);
    await client.query("INSERT INTO approval_events(id,version_id,actor_id,action,source_revision,details) VALUES($1,$2,$3,'rejected',$4,'{}'::jsonb)", [randomUUID(), versionId, actorId, Number(found.rows[0].source_revision || revision)]);
    await client.query("COMMIT");
    return { id: versionId, status: "rejected" };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function readOwnPublishedTimetable(db, user) {
  let result;
  if (user.role === "Teacher") result = await db.query(`SELECT v.id AS version_id,v.source_revision,e.* FROM timetable_versions v JOIN timetable_entries e ON e.version_id=v.id
    JOIN teachers t ON t.id=e.teacher_id WHERE v.status='approved' AND t.user_id=$1 ORDER BY e.day,e.slot`, [user.id]);
  else if (user.role === "Student") result = await db.query(`SELECT v.id AS version_id,v.source_revision,e.* FROM timetable_versions v JOIN timetable_entries e ON e.version_id=v.id
    JOIN student_profiles p ON p.batch_id=e.batch_id WHERE v.status='approved' AND p.user_id=$1 ORDER BY e.day,e.slot`, [user.id]);
  else throw new SchedulingError(403, "forbidden", "This timetable view is for linked Teacher or Student accounts.");
  return result.rowCount ? { versionId: result.rows[0].version_id, sourceRevision: Number(result.rows[0].source_revision), timetable: result.rows.map(mapEntry) } : { versionId: null, timetable: [] };
}

export function getScheduleConstants() { return ALL_SLOTS; }
