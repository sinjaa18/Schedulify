import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDomain, ALL_SLOTS } from "../src/utils/domain.js";
import { generateTimetable } from "../src/utils/scheduler.js";
import { canApproveTimetable, validateTimetable } from "../src/utils/validator.js";

function fixture({ batches = 2, sessions = 1, rooms = 2, teachers = 2 } = {}) {
  const subject = { id: "sub-math", name: "Mathematics" };
  const teacherList = Array.from({ length: teachers }, (_, i) => ({ id: `teacher-${i}`, name: `Teacher ${i}`, subjectIds: [subject.id], availableSlots: [...ALL_SLOTS] }));
  const roomList = Array.from({ length: rooms }, (_, i) => ({ id: `room-${i}`, name: `Room ${i}`, availableSlots: [...ALL_SLOTS] }));
  const batchList = Array.from({ length: batches }, (_, i) => ({ id: `batch-${i}`, name: `Grade ${i}`, availableSlots: [...ALL_SLOTS], requirements: [{ id: `req-${i}`, subjectId: subject.id, weeklySessions: sessions }] }));
  return normalizeDomain({ subjects: [subject], teachers: teacherList, rooms: roomList, batches: batchList });
}

test("two independent batches can schedule concurrently and validate", () => {
  const domain = fixture({ batches: 2, teachers: 2, rooms: 2 });
  const result = generateTimetable(domain);
  assert.equal(result.ok, true);
  assert.equal(result.timetable.length, 2);
  assert.equal(result.timetable[0].day, result.timetable[1].day);
  assert.equal(result.timetable[0].slot, result.timetable[1].slot);
  assert.equal(validateTimetable(result.timetable, domain).valid, true);
});

test("teacher, room, and batch collisions are prevented", () => {
  const domain = fixture({ batches: 2, teachers: 2, rooms: 1, sessions: 3 });
  const result = generateTimetable(domain);
  assert.equal(result.ok, true);
  assert.equal(validateTimetable(result.timetable, domain).valid, true);
  const keys = (field) => result.timetable.map((entry) => `${entry[field]}|${entry.day}|${entry.slot}`);
  assert.equal(new Set(keys("teacherId")).size, result.timetable.length);
  assert.equal(new Set(keys("roomId")).size, result.timetable.length);
  assert.equal(new Set(keys("batchId")).size, result.timetable.length);
});

test("exact batch-subject session requirements are satisfied", () => {
  const domain = fixture({ batches: 1, sessions: 4 });
  const result = generateTimetable(domain);
  assert.equal(result.ok, true);
  assert.equal(result.timetable.filter((entry) => entry.requirementId === "req-0").length, 4);
  assert.equal(validateTimetable(result.timetable, domain).valid, true);
});

test("teacher eligibility and resource availability are enforced", () => {
  const domain = fixture({ batches: 1, teachers: 1, rooms: 1 });
  domain.teachers[0].subjectIds = [];
  const unstaffed = generateTimetable(domain);
  assert.equal(unstaffed.diagnostics[0].code, "no_eligible_teacher");
  assert.equal(unstaffed.status, "infeasible");
  domain.teachers[0].subjectIds = ["sub-math"];
  domain.teachers[0].availableSlots = [];
  assert.equal(generateTimetable(domain).diagnostics[0].code, "no_available_assignment");
});

test("batch and room availability are enforced", () => {
  const domain = fixture({ batches: 1, teachers: 1, rooms: 1 });
  domain.batches[0].availableSlots = [];
  const capacity = generateTimetable(domain);
  assert.equal(capacity.diagnostics[0].code, "batch_capacity");
  assert.equal(capacity.status, "infeasible");
  domain.batches[0].availableSlots = [...ALL_SLOTS];
  domain.rooms[0].availableSlots = [];
  assert.equal(generateTimetable(domain).diagnostics[0].code, "no_available_assignment");
});

test("confirmed hard Copilot rules are enforced and unsupported rules block generation", () => {
  const domain = fixture({ batches: 1, sessions: 1, teachers: 1, rooms: 1 });
  const blocked = generateTimetable(domain, { rules: [{ type: "keep_day_free", priority: "hard", batch: "Grade 0", day: "Mon", period: "morning", validation: "ready" }] });
  assert.equal(blocked.ok, true);
  assert.equal(blocked.timetable.some((entry) => entry.day === "Mon" && ["9-10", "10-11", "11-12"].includes(entry.slot)), false);
  const unsupported = generateTimetable(domain, { rules: [{ type: "laboratory_capacity", priority: "hard", validation: "unsupported", clarification: "Not supported." }] });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.diagnostics[0].code, "unsupported_constraint");
});

test("hard Copilot preferences cannot be overridden by a conflicting soft preference", () => {
  const domain = fixture({ batches: 1, sessions: 1, teachers: 1, rooms: 1 });
  const result = generateTimetable(domain, { rules: [
    { type: "keep_day_free", priority: "hard", batch: "Grade 0", day: "Mon", validation: "ready" },
    { type: "prefer_subject_before_lunch", priority: "soft", validation: "ready" },
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.timetable.some((item) => item.day === "Mon"), false);
  assert.equal(result.timetable[0].slot, "9-10");
});

test("hard no-consecutive-teacher rule is enforced by generation", () => {
  const domain = fixture({ batches: 1, sessions: 4, teachers: 1, rooms: 1 });
  const result = generateTimetable(domain, { forwardChecking: true, rules: [{ type: "avoid_teacher_consecutive", priority: "hard", teacher: "Teacher 0", validation: "ready" }] });
  assert.equal(result.ok, true);
  const assigned = result.timetable.filter((item) => item.day === "Mon").map((item) => item.slot);
  const order = ["9-10", "10-11", "11-12", "2-3", "3-4"];
  for (let index = 0; index < order.length - 1; index += 1) {
    if (order[index] === "11-12") continue;
    assert.equal(assigned.includes(order[index]) && assigned.includes(order[index + 1]), false);
  }
});

test("impossible inputs produce explicit failure without partial timetable", () => {
  const domain = fixture({ batches: 1, sessions: 1, teachers: 1, rooms: 1 });
  domain.batches[0].availableSlots = [];
  const result = generateTimetable(domain);
  assert.equal(result.ok, false);
  assert.deepEqual(result.timetable, []);
  assert.equal(result.diagnostics[0].code, "batch_capacity");
});

test("outcomes distinguish feasible, invalid, proven infeasible, and search-limited results", () => {
  const domain = fixture({ batches: 1, sessions: 2, teachers: 1, rooms: 1 });
  assert.equal(generateTimetable(domain).status, "feasible");
  assert.equal(generateTimetable(domain, { maxNodes: 1 }).status, "search_limit");
  const limited = generateTimetable(domain, { maxNodes: 1 });
  assert.deepEqual(limited.timetable, []);
  assert.equal(limited.stats.complete, false);
  const timedOut = generateTimetable(domain, { maxDurationMs: 0 });
  assert.equal(timedOut.status, "search_limit");
  assert.equal(timedOut.diagnostics[0].code, "search_limit");
  const controller = new AbortController();
  controller.abort();
  const cancelled = generateTimetable(domain, { signal: controller.signal });
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(cancelled.timetable, []);
  const impossible = fixture({ batches: 1, sessions: 2, teachers: 1, rooms: 1 });
  impossible.teachers[0].availableSlots = [ALL_SLOTS[0]];
  impossible.rooms[0].availableSlots = [ALL_SLOTS[0]];
  assert.equal(generateTimetable(impossible).status, "infeasible");
  const invalid = fixture({ batches: 1, sessions: 1, teachers: 1, rooms: 1 });
  invalid.batches[0].requirements[0].weeklySessions = 0;
  assert.equal(generateTimetable(invalid).status, "invalid_input");
});

test("conflicting confirmed hard constraints are proven infeasible", () => {
  const domain = fixture({ batches: 1, sessions: 1, teachers: 1, rooms: 1 });
  const rules = ["Mon", "Tue", "Wed", "Thu", "Fri"].map((day) => ({ type: "keep_day_free", priority: "hard", batch: "Grade 0", day, validation: "ready" }));
  const result = generateTimetable(domain, { rules });
  assert.equal(result.status, "infeasible");
  assert.deepEqual(result.timetable, []);
});

test("identical inputs produce the same deterministic schedule", () => {
  const domain = fixture({ batches: 3, sessions: 2, teachers: 3, rooms: 2 });
  assert.deepEqual(generateTimetable(domain).timetable, generateTimetable(domain).timetable);
});

test("small exhaustive reference cases agree with scheduler feasibility", () => {
  const referenceFeasible = (domain) => {
    const tasks = domain.batches.flatMap((batch) => batch.requirements.map((requirement) => ({ batch, requirement })));
    const choices = tasks.map(({ batch, requirement }) => {
      const eligible = domain.teachers.filter((teacher) => teacher.subjectIds.includes(requirement.subjectId));
      return batch.availableSlots.flatMap((value) => {
        const [day, slot] = value.split("|");
        return eligible.filter((teacher) => teacher.availableSlots.includes(value)).flatMap((teacher) => domain.rooms.filter((room) => room.availableSlots.includes(value)).map((room) => ({ batch, teacher, room, day, slot })));
      });
    });
    const visit = (index, placed) => {
      if (index === tasks.length) return true;
      return choices[index].some((candidate) => {
        const key = `${candidate.day}|${candidate.slot}`;
        if (placed.some((other) => `${other.day}|${other.slot}` === key && (other.batch.id === candidate.batch.id || other.teacher.id === candidate.teacher.id || other.room.id === candidate.room.id))) return false;
        return visit(index + 1, [...placed, candidate]);
      });
    };
    return visit(0, []);
  };
  for (const [teacherSlots, roomSlots, expected] of [
    [[ALL_SLOTS[0]], [ALL_SLOTS[0]], false],
    [[ALL_SLOTS[0], ALL_SLOTS[1]], [ALL_SLOTS[0], ALL_SLOTS[1]], true],
    [[ALL_SLOTS[0], ALL_SLOTS[1]], [ALL_SLOTS[0]], false],
  ]) {
    const domain = fixture({ batches: 2, sessions: 1, teachers: 1, rooms: 1 });
    domain.teachers[0].availableSlots = teacherSlots;
    domain.rooms[0].availableSlots = roomSlots;
    assert.equal(referenceFeasible(domain), expected);
    for (const options of [{}, { candidateOrdering: "least_loaded" }, { forwardChecking: true }, { candidateOrdering: "least_loaded", forwardChecking: true }]) {
      assert.equal(generateTimetable(domain, options).ok, expected);
    }
  }
});

test("adaptive search solves the known-feasible resource-tight witness within its budget", () => {
  const availableSlots = ALL_SLOTS.slice(0, 13);
  const subjects = Array.from({ length: 5 }, (_, i) => ({ id: `tight-sub-${i}`, name: `Tight subject ${i}` }));
  const teachers = Array.from({ length: 7 }, (_, i) => ({ id: `tight-teacher-${i}`, name: `Tight teacher ${i}`, subjectIds: subjects.map(({ id }) => id), availableSlots }));
  const rooms = Array.from({ length: 4 }, (_, i) => ({ id: `tight-room-${i}`, name: `Tight room ${i}`, availableSlots }));
  const batches = Array.from({ length: 5 }, (_, batchIndex) => ({
    id: `tight-batch-${batchIndex}`,
    name: `Tight batch ${batchIndex}`,
    availableSlots,
    requirements: subjects.map((subject, subjectIndex) => ({ id: `tight-req-${batchIndex}-${subjectIndex}`, subjectId: subject.id, weeklySessions: 2 })),
  }));
  const domain = normalizeDomain({ batches, subjects, teachers, rooms });
  const usedTeachers = new Set();
  const usedRooms = new Set();
  const witness = [];
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    for (let subjectIndex = 0; subjectIndex < subjects.length; subjectIndex += 1) {
      for (let session = 0; session < 2; session += 1) {
        const value = ALL_SLOTS[(batchIndex * 10 + subjectIndex * 2 + session) % 13];
        const [day, slot] = value.split("|");
        const teacher = teachers.find((item) => !usedTeachers.has(`${item.id}|${value}`));
        const room = rooms.find((item) => !usedRooms.has(`${item.id}|${value}`));
        assert.ok(teacher && room, "the cyclic construction has enough teacher and room capacity per slot");
        usedTeachers.add(`${teacher.id}|${value}`);
        usedRooms.add(`${room.id}|${value}`);
        witness.push({ id: `witness-${witness.length + 1}`, batchId: batches[batchIndex].id, subjectId: subjects[subjectIndex].id, requirementId: batches[batchIndex].requirements[subjectIndex].id, teacherId: teacher.id, roomId: room.id, day, slot });
      }
    }
  }
  assert.equal(validateTimetable(witness, domain).valid, true);
  const stable = generateTimetable(domain, { maxNodes: 25_000, candidateOrdering: "stable", forwardChecking: false });
  assert.equal(stable.status, "search_limit");
  const leastLoaded = generateTimetable(domain, { maxNodes: 25_000, candidateOrdering: "least_loaded", forwardChecking: false });
  assert.equal(leastLoaded.status, "feasible");
  assert.equal(leastLoaded.stats.nodes, 88);
  const combined = generateTimetable(domain, { maxNodes: 25_000, candidateOrdering: "least_loaded", forwardChecking: true });
  assert.equal(combined.status, "feasible");
  assert.equal(combined.stats.nodes, 50);
  assert.ok(combined.stats.forwardPrunes > 0);
  assert.equal(validateTimetable(combined.timetable, domain).valid, true);
  const adaptive = generateTimetable(domain, { maxNodes: 25_000 });
  assert.deepEqual(adaptive.timetable, combined.timetable);
});

test("validator catches corrupted assignments and weekly-count errors", () => {
  const domain = fixture({ batches: 1, sessions: 1, teachers: 1, rooms: 1 });
  const corrupted = [
    { id: "a", batchId: "batch-0", subjectId: "sub-math", teacherId: "teacher-0", roomId: "room-0", day: "Mon", slot: "9-10", requirementId: "req-0" },
    { id: "b", batchId: "batch-0", subjectId: "sub-math", teacherId: "teacher-0", roomId: "room-0", day: "Mon", slot: "9-10", requirementId: "req-0" },
    { id: "c", batchId: "batch-0", subjectId: "sub-math", teacherId: "ghost", roomId: "room-0", day: "Sun", slot: "12-1", requirementId: "req-0" },
  ];
  const result = validateTimetable(corrupted, domain);
  assert.equal(result.valid, false);
  const codes = new Set(result.violations.map((item) => item.code));
  assert.ok(codes.has("batch_double_booking"));
  assert.ok(codes.has("teacher_double_booking"));
  assert.ok(codes.has("room_double_booking"));
  assert.ok(codes.has("missing_resource"));
  assert.ok(codes.has("invalid_slot"));
  assert.ok(codes.has("weekly_session_count"));
});

test("validator catches ineligible teachers and unavailable assignments", () => {
  const domain = fixture({ batches: 1, sessions: 1, teachers: 1, rooms: 1 });
  const generated = generateTimetable(domain);
  domain.teachers[0].subjectIds = [];
  domain.teachers[0].availableSlots = [];
  const result = validateTimetable(generated.timetable, domain);
  const codes = new Set(result.violations.map((item) => item.code));
  assert.ok(codes.has("ineligible_teacher"));
  assert.ok(codes.has("unavailable_slot"));
});

test("hard consecutive-teacher requirement is independently validated", () => {
  const domain = fixture({ batches: 1, sessions: 2, teachers: 1, rooms: 2 });
  const [first, second] = ["9-10", "10-11"].map((slot, i) => ({ id: `a${i}`, batchId: "batch-0", subjectId: "sub-math", teacherId: "teacher-0", roomId: `room-${i}`, day: "Mon", slot, requirementId: "req-0" }));
  const result = validateTimetable([first, second], domain, { rules: [{ type: "avoid_teacher_consecutive", priority: "hard", teacher: "Teacher 0", validation: "ready" }] });
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((item) => item.code === "hard_rule_violation"));
});

test("invalid or empty schedules cannot be approved", () => {
  const domain = fixture({ batches: 1, sessions: 1, teachers: 1, rooms: 1 });
  const generated = generateTimetable(domain);
  assert.equal(canApproveTimetable(generated.timetable, domain), true);
  assert.equal(canApproveTimetable([{ ...generated.timetable[0], slot: "12-1" }], domain), false);
  assert.equal(canApproveTimetable([], domain), false);
});

test("old resource records migrate without losing names and receive stable IDs", () => {
  const first = normalizeDomain({ teachers: ["Teacher Legacy"], subjects: [{ name: "History", minPerWeek: 3 }], rooms: ["Room Legacy"] });
  const second = normalizeDomain({ teachers: ["Teacher Legacy"], subjects: [{ name: "History", minPerWeek: 3 }], rooms: ["Room Legacy"] });
  assert.equal(first.teachers[0].name, "Teacher Legacy");
  assert.equal(first.subjects[0].minPerWeek, 3);
  assert.equal(first.rooms[0].name, "Room Legacy");
  assert.equal(first.teachers[0].id, second.teachers[0].id);
  assert.deepEqual(first.teachers[0].subjectIds, []);
});
