import { ALL_SLOTS, PERIODS, resolveRuleConstraints, slotKey } from "./domain.js";
import { validateTimetable } from "./validator.js";

const byId = (items) => new Map(items.map((item) => [item.id, item]));
const has = (values, value) => Array.isArray(values) && values.includes(value);
const periodOf = (slot) => PERIODS.morning.includes(slot) ? "morning" : "afternoon";
const adjacentIndex = (index) => index === 0 ? [1] : index === 1 ? [0, 2] : index === 2 ? [1] : index === 3 ? [4] : [3];
const teacherPeriodKey = (teacherId, day, index) => `${teacherId}|${day}|${index}`;
const applies = (constraint, task, option) =>
  (!constraint.batchId || constraint.batchId === task.batchId) &&
  (!constraint.teacherId || constraint.teacherId === option.teacherId) &&
  (!constraint.subjectId || constraint.subjectId === task.subjectId) &&
  (!constraint.day || constraint.day === option.day) &&
  (!constraint.period || constraint.period === periodOf(option.slot));

function preferenceDelta(option, task, state, softRules) {
  let score = 0;
  for (const rule of softRules) {
    if (!applies(rule, task, option)) continue;
    if (rule.type === "prefer_subject_before_lunch" && periodOf(option.slot) === "morning") score += 10;
    if (rule.type === "keep_day_free") score -= 10;
    if (rule.type === "avoid_teacher_consecutive") {
      const i = option.orderInPeriod;
      if (adjacentIndex(i).some((index) => state.teacherPeriods.has(teacherPeriodKey(option.teacherId, option.day, option.periodBase + index)))) score -= 10;
    }
  }
  return score;
}

function allowed(task, option, state, hardRules) {
  if (state.batchSlots.has(option.batchSlotKey) || state.teacherSlots.has(option.teacherSlotKey) || state.roomSlots.has(option.roomSlotKey)) return false;
  if (state.byRequirement.has(task.requirementId) && option.order <= state.byRequirement.get(task.requirementId)) return false;
  for (const rule of hardRules) {
    if (!applies(rule, task, option)) continue;
    if (rule.type === "keep_day_free") return false;
    if (rule.type === "prefer_subject_before_lunch" && periodOf(option.slot) !== "morning") return false;
    if (rule.type === "avoid_teacher_consecutive") {
      const i = option.orderInPeriod;
      if (adjacentIndex(i).some((index) => state.teacherPeriods.has(teacherPeriodKey(option.teacherId, option.day, option.periodBase + index)))) return false;
    }
  }
  return true;
}

/** Deterministic CSP search. Complete result or explicit failure; partial placements are never returned as success. */
export function generateTimetable(domain, { rules = [], maxNodes = 1_000_000, maxDurationMs = Infinity, signal, candidateOrdering = "adaptive", forwardChecking = "adaptive" } = {}) {
  const startedAt = performance.now();
  const { batches = [], subjects = [], teachers = [], rooms = [] } = domain || {};
  const batchById = byId(batches); const subjectById = byId(subjects);
  const diagnostics = [];
  for (const [kind, items] of [["batch", batches], ["subject", subjects], ["teacher", teachers], ["room", rooms]]) {
    const ids = new Set();
    const names = new Set();
    for (const item of items) {
      if (!item?.id || ids.has(item.id)) diagnostics.push({ code: "duplicate_or_missing_id", severity: "error", message: `Every ${kind} needs a unique stable ID.`, resourceId: item?.id || null });
      ids.add(item?.id);
      if (typeof item?.name !== "string" || !item.name.trim()) diagnostics.push({ code: "invalid_resource_name", severity: "error", message: `Every ${kind} needs a non-empty name.`, resourceId: item?.id || null });
      if (typeof item?.name === "string" && names.has(item.name.toLowerCase())) diagnostics.push({ code: "duplicate_resource_name", severity: "error", message: `${kind} names must be unique so Copilot references are unambiguous.`, resourceId: item.id });
      if (typeof item?.name === "string") names.add(item.name.toLowerCase());
      if (kind !== "subject" && (!Array.isArray(item?.availableSlots) || item.availableSlots.some((value) => !ALL_SLOTS.includes(value)))) diagnostics.push({ code: "invalid_availability", severity: "error", message: `${kind} ${item?.name || item?.id || "(unknown)"} has an invalid availability list.`, resourceId: item?.id || null });
    }
  }
  for (const teacher of teachers) for (const subjectId of teacher.subjectIds || []) if (!subjectById.has(subjectId)) diagnostics.push({ code: "invalid_eligibility", severity: "error", teacherId: teacher.id, subjectId, message: `${teacher.name} is eligible for a subject that does not exist.` });
  const allRequirementIds = new Set();
  for (const batch of batches) {
    const subjectIds = new Set(); const requirementIds = new Set();
    for (const requirement of batch.requirements || []) {
      if (subjectIds.has(requirement.subjectId)) diagnostics.push({ code: "duplicate_requirement", severity: "error", batchId: batch.id, subjectId: requirement.subjectId, message: `${batch.name} has more than one weekly requirement for the same subject.` });
      if (!requirement.id || requirementIds.has(requirement.id)) diagnostics.push({ code: "duplicate_requirement_id", severity: "error", batchId: batch.id, requirementId: requirement.id, message: `${batch.name} requirements need unique stable IDs.` });
      if (allRequirementIds.has(requirement.id)) diagnostics.push({ code: "duplicate_requirement_id", severity: "error", batchId: batch.id, requirementId: requirement.id, message: "Requirement IDs must be unique across all batches." });
      subjectIds.add(requirement.subjectId); requirementIds.add(requirement.id);
      allRequirementIds.add(requirement.id);
    }
  }
  const resolvedRules = resolveRuleConstraints(rules, { batches, subjects, teachers });
  if (resolvedRules.unsupported.length) return { ok: false, status: "invalid_input", timetable: [], diagnostics: resolvedRules.unsupported.map(({ rule, reason }) => ({ code: "unsupported_constraint", severity: "error", message: reason, rule })), stats: { nodes: 0, elapsedMs: performance.now() - startedAt } };

  const tasks = [];
  for (const batch of batches) {
    if (!Array.isArray(batch.requirements)) {
      diagnostics.push({ code: "invalid_batch_requirements", severity: "error", batchId: batch.id, message: `Batch ${batch.name} has invalid requirements.` });
      continue;
    }
    for (const requirement of batch.requirements) {
      if (!requirement || typeof requirement !== "object") {
        diagnostics.push({ code: "invalid_requirement", severity: "error", batchId: batch.id, message: `Batch ${batch.name} contains an invalid requirement record.` });
        continue;
      }
      const subject = subjectById.get(requirement.subjectId);
      const count = requirement.weeklySessions;
      if (!subject || !Number.isInteger(count) || count < 1 || count > ALL_SLOTS.length) {
        diagnostics.push({ code: "invalid_requirement", severity: "error", batchId: batch.id, requirementId: requirement.id, message: `Batch ${batch.name} has an invalid subject or weekly session count.` });
        continue;
      }
      const eligible = teachers.filter((teacher) => Array.isArray(teacher.subjectIds) && teacher.subjectIds.includes(subject.id));
      if (!eligible.length) diagnostics.push({ code: "no_eligible_teacher", severity: "error", batchId: batch.id, subjectId: subject.id, message: `No teacher is explicitly eligible to teach ${subject.name} for ${batch.name}.` });
      if (!rooms.length) diagnostics.push({ code: "no_rooms", severity: "error", batchId: batch.id, subjectId: subject.id, message: `No rooms are configured for ${subject.name} in ${batch.name}.` });
      for (let index = 0; index < count; index += 1) tasks.push({ batchId: batch.id, requirementId: requirement.id, subjectId: subject.id, subjectName: subject.name, batchName: batch.name, session: index });
    }
  }
  if (diagnostics.length) {
    const provenCodes = new Set(["no_eligible_teacher", "no_rooms"]);
    const proven = diagnostics.every((item) => provenCodes.has(item.code));
    return { ok: false, status: proven ? "infeasible" : "invalid_input", timetable: [], diagnostics, stats: { nodes: 0, elapsedMs: performance.now() - startedAt, complete: proven } };
  }
  if (!tasks.length) return { ok: false, status: "invalid_input", timetable: [], diagnostics: [{ code: "no_requirements", severity: "error", message: "Add at least one batch subject requirement before generating a timetable." }], stats: { nodes: 0, elapsedMs: performance.now() - startedAt } };
  for (const batch of batches) {
    const required = tasks.filter((task) => task.batchId === batch.id).length;
    const available = new Set(batch.availableSlots).size;
    if (required > available) diagnostics.push({ code: "batch_capacity", severity: "error", batchId: batch.id, requiredSessions: required, availableSlots: available, message: `${batch.name} requires ${required} sessions but has only ${available} available slots.` });
  }
  if (diagnostics.length) return { ok: false, status: "infeasible", timetable: [], diagnostics, stats: { nodes: 0, elapsedMs: performance.now() - startedAt, complete: true } };

  const domainGroupsByTask = [];
  const optionsByTask = tasks.map((task) => {
    const eligible = teachers.filter((teacher) => teacher.subjectIds.includes(task.subjectId));
    const options = [];
    const groups = [];
    for (const value of ALL_SLOTS) {
      const [day, slot] = value.split("|");
      if (!has(batchById.get(task.batchId).availableSlots, value)) continue;
      const availableTeachers = eligible.filter((teacher) => has(teacher.availableSlots, value));
      const availableRooms = rooms.filter((room) => has(room.availableSlots, value));
      if (!availableTeachers.length || !availableRooms.length) continue;
      const order = ALL_SLOTS.indexOf(value);
      const morning = PERIODS.morning.includes(slot);
      const key = slotKey(day, slot);
      const group = { order, batchSlotKey: `${task.batchId}|${key}`, roomOptions: null, optionsByTeacher: new Map() };
      for (const teacher of availableTeachers) {
        const teacherOptions = [];
        for (const room of availableRooms) {
          const option = { day, slot, order, orderInPeriod: morning ? PERIODS.morning.indexOf(slot) : PERIODS.afternoon.indexOf(slot), periodBase: morning ? 0 : 3, slotLoadKey: key, batchSlotKey: group.batchSlotKey, teacherSlotKey: `${teacher.id}|${key}`, roomSlotKey: `${room.id}|${key}`, teacherId: teacher.id, teacherName: teacher.name, roomId: room.id, roomName: room.name };
          options.push(option);
          teacherOptions.push(option);
        }
        group.optionsByTeacher.set(teacher.id, teacherOptions);
      }
      group.roomOptions = group.optionsByTeacher.values().next().value;
      groups.push(group);
    }
    domainGroupsByTask.push(groups);
    return options;
  });
  const noAvailability = optionsByTask.findIndex((options) => !options.length);
  if (noAvailability >= 0) {
    const task = tasks[noAvailability];
    return { ok: false, status: "infeasible", timetable: [], diagnostics: [{ code: "no_available_assignment", severity: "error", batchId: task.batchId, subjectId: task.subjectId, requirementId: task.requirementId, message: `No available teacher, room, and time-slot combination exists for ${task.subjectName} in ${task.batchName}.` }], stats: { nodes: 0, elapsedMs: performance.now() - startedAt, complete: true } };
  }

  const hardRules = resolvedRules.constraints.filter((rule) => rule.priority === "hard");
  const softRules = resolvedRules.constraints.filter((rule) => rule.priority === "soft");
  const roomCapacity = rooms.reduce((sum, room) => sum + new Set(room.availableSlots).size, 0);
  const teacherCapacity = teachers.reduce((sum, teacher) => sum + new Set(teacher.availableSlots).size, 0);
  const resourceTightness = tasks.length / Math.max(1, Math.min(roomCapacity, teacherCapacity));
  const useLeastLoaded = candidateOrdering === "least_loaded" || (candidateOrdering === "adaptive" && resourceTightness >= 0.8);
  const useForwardChecking = forwardChecking === true || (forwardChecking === "adaptive" && resourceTightness >= 0.8);
  const state = { batchSlots: new Set(), teacherSlots: new Set(), teacherPeriods: new Set(), roomSlots: new Set(), byRequirement: new Map(), slotLoads: new Map(), placed: [] };
  let nodes = 0; let capped = false; let stopReason = null; let deepest = 0; let backtracks = 0; let candidateChecks = 0; let rejectedCandidates = 0; let forwardChecks = 0; let forwardPrunes = 0;
  const deadlineAt = Number.isFinite(maxDurationMs) ? startedAt + Math.max(0, maxDurationMs) : Infinity;
  function stopIfNeeded() {
    if (signal?.aborted) { capped = true; stopReason = "cancelled"; return true; }
    if (performance.now() >= deadlineAt) { capped = true; stopReason = "deadline"; return true; }
    if (nodes >= maxNodes) { capped = true; stopReason = "node_budget"; return true; }
    return false;
  }
  function requirementsRemainFeasible(remaining) {
    forwardChecks += 1;
    const pending = new Map();
    for (const taskIndex of remaining) {
      const task = tasks[taskIndex];
      const entry = pending.get(task.requirementId) || { task, taskIndex, count: 0 };
      entry.count += 1;
      pending.set(task.requirementId, entry);
    }
    // A requirement's sessions share one domain and need distinct batch slots.
    // Fewer legal future slots than remaining sessions is therefore a safe proof of failure.
    for (const { task, taskIndex, count: needed } of pending.values()) {
      let possibleSlots = 0;
      for (const group of domainGroupsByTask[taskIndex]) {
        if (state.batchSlots.has(group.batchSlotKey) || (state.byRequirement.has(task.requirementId) && group.order <= state.byRequirement.get(task.requirementId))) continue;
        let freeRooms = 0;
        for (const option of group.roomOptions) if (!state.roomSlots.has(option.roomSlotKey)) freeRooms += 1;
        if (!freeRooms) continue;
        let hasTeacher = false;
        for (const teacherOptions of group.optionsByTeacher.values()) {
          const teacherOption = teacherOptions.find((option) => !state.roomSlots.has(option.roomSlotKey));
          if (!teacherOption || state.teacherSlots.has(teacherOption.teacherSlotKey)) continue;
          candidateChecks += 1;
          if (allowed(task, teacherOption, state, hardRules)) { hasTeacher = true; break; }
          rejectedCandidates += 1;
        }
        if (hasTeacher) possibleSlots += 1;
        if ((candidateChecks & 1023) === 0 && stopIfNeeded()) return false;
      }
      if (possibleSlots < needed) return false;
    }
    return !capped;
  }
  function search(remaining) {
    if (!remaining.length) return true;
    if (stopIfNeeded()) return false;
    nodes += 1; deepest = Math.max(deepest, tasks.length - remaining.length);
    let chosenPosition = -1; let chosenCount = Infinity;
    for (let position = 0; position < remaining.length; position += 1) {
      const taskIndex = remaining[position];
      const task = tasks[taskIndex];
      let count = 0;
      for (const group of domainGroupsByTask[taskIndex]) {
        if (state.batchSlots.has(group.batchSlotKey) || (state.byRequirement.has(task.requirementId) && group.order <= state.byRequirement.get(task.requirementId))) continue;
        const freeRooms = group.roomOptions.filter((option) => !state.roomSlots.has(option.roomSlotKey));
        if (!freeRooms.length) continue;
        for (const teacherOptions of group.optionsByTeacher.values()) {
          const teacherOption = teacherOptions.find((option) => !state.roomSlots.has(option.roomSlotKey));
          if (!teacherOption || state.teacherSlots.has(teacherOption.teacherSlotKey)) continue;
          candidateChecks += 1;
          if (allowed(task, teacherOption, state, hardRules)) count += freeRooms.length;
          else rejectedCandidates += 1;
          if ((candidateChecks & 1023) === 0 && stopIfNeeded()) return false;
        }
      }
      if (count < chosenCount) {
        chosenPosition = position; chosenCount = count;
        if (!count) break;
      }
    }
    if (capped) return false;
    if (!chosenCount) return false;
    const taskIndex = remaining[chosenPosition]; const task = tasks[taskIndex];
    const chosenCandidates = [];
    for (const option of optionsByTask[taskIndex]) {
      candidateChecks += 1;
      if (allowed(task, option, state, hardRules)) chosenCandidates.push(option);
      else rejectedCandidates += 1;
      if ((candidateChecks & 1023) === 0 && stopIfNeeded()) return false;
    }
    if (capped) return false;
    chosenCandidates.sort((a, b) => preferenceDelta(b, task, state, softRules) - preferenceDelta(a, task, state, softRules) ||
      (useLeastLoaded ? (state.slotLoads.get(a.slotLoadKey) || 0) - (state.slotLoads.get(b.slotLoadKey) || 0) : 0) ||
      a.order - b.order || a.teacherId.localeCompare(b.teacherId) || a.roomId.localeCompare(b.roomId));
    const next = remaining.filter((_, position) => position !== chosenPosition);
    for (const option of chosenCandidates) {
      const previousOrder = state.byRequirement.get(task.requirementId);
      const slotLoadKey = option.slotLoadKey;
      state.batchSlots.add(option.batchSlotKey); state.teacherSlots.add(option.teacherSlotKey); state.roomSlots.add(option.roomSlotKey); state.teacherPeriods.add(teacherPeriodKey(option.teacherId, option.day, option.periodBase + option.orderInPeriod)); state.byRequirement.set(task.requirementId, option.order); state.slotLoads.set(slotLoadKey, (state.slotLoads.get(slotLoadKey) || 0) + 1);
      state.placed.push({ batchId: task.batchId, batch: task.batchName, subjectId: task.subjectId, subject: task.subjectName, requirementId: task.requirementId, teacherId: option.teacherId, teacher: option.teacherName, roomId: option.roomId, room: option.roomName, day: option.day, slot: option.slot });
      const forwardFeasible = !useForwardChecking || requirementsRemainFeasible(next);
      if (forwardFeasible && search(next)) return true;
      if (!forwardFeasible && !capped) forwardPrunes += 1;
      if (!capped) backtracks += 1;
      state.placed.pop(); state.batchSlots.delete(option.batchSlotKey); state.teacherSlots.delete(option.teacherSlotKey); state.teacherPeriods.delete(teacherPeriodKey(option.teacherId, option.day, option.periodBase + option.orderInPeriod)); state.roomSlots.delete(option.roomSlotKey);
      const nextLoad = state.slotLoads.get(slotLoadKey) - 1;
      if (nextLoad) state.slotLoads.set(slotLoadKey, nextLoad); else state.slotLoads.delete(slotLoadKey);
      if (previousOrder === undefined) state.byRequirement.delete(task.requirementId); else state.byRequirement.set(task.requirementId, previousOrder);
      if (capped) return false;
    }
    return false;
  }
  const ok = search(tasks.map((_, index) => index));
  const elapsedMs = performance.now() - startedAt;
  if (!ok) {
    const status = stopReason === "cancelled" ? "cancelled" : capped ? "search_limit" : "infeasible";
    const code = status === "infeasible" ? "infeasible" : status;
    const reason = stopReason === "cancelled" ? "Search was cancelled" : stopReason === "deadline" ? `Search reached its ${maxDurationMs} ms time limit` : stopReason === "node_budget" ? `Search reached the ${maxNodes.toLocaleString()}-node safety limit` : "No timetable satisfies all required sessions and configured hard constraints; search exhausted the feasible combinations";
    const message = status === "infeasible" ? `${reason} for ${tasks.length} required sessions.` : `${reason} after placing ${deepest} of ${tasks.length} required sessions. No partial timetable was kept.`;
    return { ok: false, status, timetable: [], diagnostics: [{ code, severity: "error", message, nodes, requiredSessions: tasks.length }], stats: { nodes, elapsedMs, backtracks, candidateChecks, rejectedCandidates, forwardChecks, forwardPrunes, maxDepth: deepest, complete: !capped, terminationReason: stopReason } };
  }
  const timetable = state.placed.map((entry, index) => ({ ...entry, id: `assignment-${index + 1}` }));
  const checked = validateTimetable(timetable, domain, { rules });
  if (!checked.valid) return { ok: false, status: "invalid_candidate", timetable: [], diagnostics: checked.violations, stats: { nodes, elapsedMs, backtracks, candidateChecks, rejectedCandidates, forwardChecks, forwardPrunes, maxDepth: deepest, complete: true } };
  return { ok: true, status: "feasible", timetable, diagnostics: [], stats: { nodes, elapsedMs, backtracks, candidateChecks, rejectedCandidates, forwardChecks, forwardPrunes, maxDepth: deepest, requiredSessions: tasks.length, complete: true } };
}
