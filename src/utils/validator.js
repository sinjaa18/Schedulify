import { ALL_SLOTS, PERIODS, slotKey } from "./domain.js";

const periodOf = (slot) => PERIODS.morning.includes(slot) ? "morning" : PERIODS.afternoon.includes(slot) ? "afternoon" : null;
const indexOf = (slot) => ["9-10", "10-11", "11-12", "2-3", "3-4"].indexOf(slot);

function matchesScope(rule, assignment, domain) {
  const batch = rule.batch ? domain.batches.find((item) => item.name.toLowerCase() === rule.batch.toLowerCase()) : null;
  const teacher = rule.teacher ? domain.teachers.find((item) => item.name.toLowerCase() === rule.teacher.toLowerCase()) : null;
  const subject = rule.subject ? domain.subjects.find((item) => item.name.toLowerCase() === rule.subject.toLowerCase()) : null;
  if (rule.batch && !batch || rule.teacher && !teacher || rule.subject && !subject) return false;
  return (!batch || assignment.batchId === batch.id) && (!teacher || assignment.teacherId === teacher.id) &&
    (!subject || assignment.subjectId === subject.id) && (!rule.day || assignment.day === rule.day) &&
    (!rule.period || periodOf(assignment.slot) === rule.period);
}

/** Inspects assignment rows independently of the scheduler's search state. */
export function validateTimetable(timetable, domain, { rules = [] } = {}) {
  const assignments = Array.isArray(timetable) ? timetable : [];
  const violations = [];
  const unmetPreferences = [];
  const batches = new Map(domain.batches.map((item) => [item.id, item]));
  const subjects = new Map(domain.subjects.map((item) => [item.id, item]));
  const teachers = new Map(domain.teachers.map((item) => [item.id, item]));
  const rooms = new Map(domain.rooms.map((item) => [item.id, item]));
  const counts = new Map();
  const seen = { batch: new Map(), teacher: new Map(), room: new Map() };
  const assignmentIds = new Set();
  const add = (code, message, assignment, extra = {}) => violations.push({ code, severity: "error", message, assignmentId: assignment?.id || null, ...extra });

  assignments.forEach((assignment, index) => {
    if (!assignment || typeof assignment !== "object") { add("invalid_assignment", `Assignment ${index + 1} is not an object.`); return; }
    if (!assignment.id || assignmentIds.has(assignment.id)) add("invalid_assignment_id", `Assignment ${index + 1} needs a unique stable ID.`, assignment);
    assignmentIds.add(assignment.id);
    const batch = batches.get(assignment.batchId); const subject = subjects.get(assignment.subjectId);
    const teacher = teachers.get(assignment.teacherId); const room = rooms.get(assignment.roomId);
    if (!batch || !subject || !teacher || !room) add("missing_resource", `Assignment ${assignment.id || index + 1} must reference an existing batch, subject, teacher, and room.`, assignment);
    const key = slotKey(assignment.day, assignment.slot);
    if (!ALL_SLOTS.includes(key)) add("invalid_slot", `Assignment ${assignment.id || index + 1} uses an invalid day or time slot.`, assignment);
    for (const [kind, id, resource, name] of [["batch", assignment.batchId, batch, "batch"], ["teacher", assignment.teacherId, teacher, "teacher"], ["room", assignment.roomId, room, "room"]]) {
      if (!resource || !ALL_SLOTS.includes(key)) continue;
      if (!resource.availableSlots?.includes(key)) add("unavailable_slot", `${name} ${resource.name} is unavailable at ${assignment.day} ${assignment.slot}.`, assignment, { resourceId: id });
      const collisionKey = `${id}|${key}`;
      const prior = seen[kind].get(collisionKey);
      if (prior) add(`${kind}_double_booking`, `${name} ${resource.name} has multiple assignments at ${assignment.day} ${assignment.slot}.`, assignment, { conflictingAssignmentId: prior.id, resourceId: id });
      else seen[kind].set(collisionKey, assignment);
    }
    if (teacher && subject && !teacher.subjectIds?.includes(subject.id)) add("ineligible_teacher", `${teacher.name} is not explicitly eligible to teach ${subject.name}.`, assignment, { teacherId: teacher.id, subjectId: subject.id });
    if (batch && subject) {
      const requirement = batch.requirements?.find((item) => item.subjectId === subject.id);
      if (!requirement) add("unrequired_class", `${batch.name} has no weekly requirement for ${subject.name}.`, assignment, { batchId: batch.id, subjectId: subject.id });
      else {
        if (assignment.requirementId !== requirement.id) add("invalid_requirement_reference", `${batch.name} ${subject.name} assignment does not reference its batch requirement.`, assignment, { batchId: batch.id, subjectId: subject.id, requirementId: assignment.requirementId });
        counts.set(requirement.id, (counts.get(requirement.id) || 0) + 1);
      }
    }
  });

  for (const batch of domain.batches) for (const requirement of batch.requirements || []) {
    if (!requirement || typeof requirement !== "object") { add("invalid_requirement", `${batch.name} contains an invalid requirement record.`, null, { batchId: batch.id }); continue; }
    const subject = subjects.get(requirement.subjectId);
    const actual = counts.get(requirement.id) || 0;
    if (!subject) { add("invalid_requirement", `${batch.name} has a requirement for an unknown subject.`, null, { batchId: batch.id, requirementId: requirement.id }); continue; }
    if (actual !== requirement.weeklySessions) add("weekly_session_count", `${batch.name} requires ${requirement.weeklySessions} ${subject.name} session(s) per week but has ${actual}.`, null, { batchId: batch.id, subjectId: subject.id, requirementId: requirement.id, expected: requirement.weeklySessions, actual });
  }

  for (const rule of rules) {
    const hasName = (items, name) => typeof name === "string" && items.some((item) => item.name.toLowerCase() === name.toLowerCase());
    const referencesExist = (rule.batch == null || hasName(domain.batches, rule.batch)) &&
      (rule.teacher == null || hasName(domain.teachers, rule.teacher)) &&
      (rule.subject == null || hasName(domain.subjects, rule.subject));
    const validScope = ["hard", "soft"].includes(rule.priority) && (!rule.day || ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(rule.day)) && (!rule.period || ["morning", "afternoon"].includes(rule.period));
    const unsupported = rule.validation !== "ready" || !["keep_day_free", "prefer_subject_before_lunch", "avoid_teacher_consecutive"].includes(rule.type) || !referencesExist || !validScope;
    if (unsupported) {
      if (rule.priority === "hard" || !validScope) add("unsupported_hard_constraint", rule.clarification || `Copilot requirement ${rule.type} has an unsupported scope or cannot be validated.`, null, { rule });
      else unmetPreferences.push({ code: "unsupported_preference", message: rule.clarification || `Copilot preference ${rule.type} is unsupported.`, rule });
      continue;
    }
    if (rule.type === "keep_day_free") {
      const matching = assignments.filter((assignment) => matchesScope(rule, assignment, domain));
      if (matching.length) {
        const message = `${rule.batch || "The selected batch(es)"} has ${matching.length} assignment(s) during the requested free period.`;
        if (rule.priority === "hard") add("hard_rule_violation", message, matching[0], { rule, conflictingAssignmentIds: matching.map((item) => item.id) });
        else unmetPreferences.push({ code: "preference_unmet", message, rule });
      }
    }
    if (rule.type === "prefer_subject_before_lunch") {
      const matching = assignments.filter((assignment) => matchesScope(rule, assignment, domain) && periodOf(assignment.slot) === "afternoon");
      if (matching.length) {
        const message = `${matching.length} matching class(es) are in the afternoon, contrary to the preference.`;
        if (rule.priority === "hard") add("hard_rule_violation", message, matching[0], { rule, conflictingAssignmentIds: matching.map((item) => item.id) });
        else unmetPreferences.push({ code: "preference_unmet", message, rule });
      }
    }
    if (rule.type === "avoid_teacher_consecutive") {
      const matches = assignments.filter((assignment) => matchesScope(rule, assignment, domain));
      const conflicts = [];
      for (const first of matches) for (const second of matches) {
        if (first.id >= second.id || first.teacherId !== second.teacherId || first.day !== second.day) continue;
        const a = indexOf(first.slot); const b = indexOf(second.slot);
        if (periodOf(first.slot) === periodOf(second.slot) && Math.abs(a - b) === 1) conflicts.push([first, second]);
      }
      if (conflicts.length) {
        const message = `${conflicts.length} adjacent teaching slot(s) remain for the selected teacher.`;
        if (rule.priority === "hard") add("hard_rule_violation", message, conflicts[0][0], { rule, conflictingAssignmentIds: conflicts.flat().map((item) => item.id) });
        else unmetPreferences.push({ code: "preference_unmet", message, rule });
      }
    }
  }
  return { valid: violations.length === 0, violations, unmetPreferences, assignmentCount: assignments.length };
}

export function canApproveTimetable(timetable, domain, rules = []) {
  return Array.isArray(timetable) && timetable.length > 0 && validateTimetable(timetable, domain, { rules }).valid;
}
