export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
export const SLOTS = ["9-10", "10-11", "11-12", "2-3", "3-4"];
export const PERIODS = { morning: ["9-10", "10-11", "11-12"], afternoon: ["2-3", "3-4"] };
export const ALL_SLOTS = DAYS.flatMap((day) => SLOTS.map((slot) => `${day}|${slot}`));

function legacyId(kind, value, index) {
  const text = `${kind}:${String(value)}:${index}`;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `legacy-${kind}-${(hash >>> 0).toString(36)}`;
}

export function normalizeDomain({ teachers = [], subjects = [], rooms = [], batches = [] } = {}) {
  const normalizedSubjects = subjects.map((item, index) => {
    const value = typeof item === "string" ? { name: item } : item || {};
    const name = String(value.name || "").trim();
    return { ...value, id: value.id || legacyId("subject", name, index), name };
  }).filter((item) => item.name);
  const normalizedTeachers = teachers.map((item, index) => {
    const value = typeof item === "string" ? { name: item } : item || {};
    const name = String(value.name || "").trim();
    return { ...value, id: value.id || legacyId("teacher", name, index), name,
      subjectIds: Array.isArray(value.subjectIds) ? value.subjectIds : [],
      availableSlots: Array.isArray(value.availableSlots) ? value.availableSlots : [...ALL_SLOTS] };
  }).filter((item) => item.name);
  const normalizedRooms = rooms.map((item, index) => {
    const value = typeof item === "string" ? { name: item } : item || {};
    const name = String(value.name || "").trim();
    return { ...value, id: value.id || legacyId("room", name, index), name,
      availableSlots: Array.isArray(value.availableSlots) ? value.availableSlots : [...ALL_SLOTS] };
  }).filter((item) => item.name);
  const normalizedBatches = batches.map((item, index) => {
    const value = typeof item === "string" ? { name: item } : item || {};
    const name = String(value.name || "").trim();
    const id = value.id || legacyId("batch", name, index);
    const requirements = Array.isArray(value.requirements) ? value.requirements.map((requirement, reqIndex) => {
      const source = requirement && typeof requirement === "object" ? requirement : {};
      return { ...source, id: source.id || legacyId(`requirement-${id}`, source.subjectId || reqIndex, reqIndex) };
    }) : [];
    return { ...value, id, name,
      requirements,
      availableSlots: Array.isArray(value.availableSlots) ? value.availableSlots : [...ALL_SLOTS] };
  }).filter((item) => item.name);
  return { teachers: normalizedTeachers, subjects: normalizedSubjects, rooms: normalizedRooms, batches: normalizedBatches };
}

export function createId(prefix) {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

export function slotKey(day, slot) { return `${day}|${slot}`; }

export function resolveRuleConstraints(rules = [], domain) {
  const constraints = [];
  const unsupported = [];
  const findByName = (items, name) => items.find((item) => item.name.toLowerCase() === String(name).toLowerCase());
  for (const rule of rules) {
    if (rule.validation === "needs_clarification") {
      unsupported.push({ rule, reason: rule.clarification || "This requirement needs clarification." });
      continue;
    }
    if (rule.validation !== "ready" || !["keep_day_free", "prefer_subject_before_lunch", "avoid_teacher_consecutive"].includes(rule.type)) {
      unsupported.push({ rule, reason: rule.clarification || "The scheduler does not support this requirement." });
      continue;
    }
    if (!["hard", "soft"].includes(rule.priority) || rule.day && !DAYS.includes(rule.day) || rule.period && !["morning", "afternoon"].includes(rule.period)) {
      unsupported.push({ rule, reason: "The requirement contains an invalid priority, day, or period." });
      continue;
    }
    const constraint = { type: rule.type, priority: rule.priority, day: rule.day || null, period: rule.period || null,
      batchId: null, teacherId: null, subjectId: null, rule };
    if (rule.batch) {
      const batch = findByName(domain.batches, rule.batch);
      if (!batch) { unsupported.push({ rule, reason: `Unknown batch “${rule.batch}”.` }); continue; }
      constraint.batchId = batch.id;
    }
    if (rule.teacher) {
      const teacher = findByName(domain.teachers, rule.teacher);
      if (!teacher) { unsupported.push({ rule, reason: `Unknown teacher “${rule.teacher}”.` }); continue; }
      constraint.teacherId = teacher.id;
    }
    if (rule.subject) {
      const subject = findByName(domain.subjects, rule.subject);
      if (!subject) { unsupported.push({ rule, reason: `Unknown subject “${rule.subject}”.` }); continue; }
      constraint.subjectId = subject.id;
    }
    constraints.push(constraint);
  }
  return { constraints, unsupported };
}
