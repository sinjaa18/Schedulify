import os from "node:os";
import { normalizeDomain, ALL_SLOTS } from "../src/utils/domain.js";
import { generateTimetable } from "../src/utils/scheduler.js";
import { validateTimetable } from "../src/utils/validator.js";

function fixture({ batchCount, subjectCount, sessions, teacherCount, roomCount, batchSlots = ALL_SLOTS, teacherSlots = ALL_SLOTS, roomSlots = ALL_SLOTS, eligibility = null }) {
  const subjects = Array.from({ length: subjectCount }, (_, index) => ({ id: `s${index}`, name: `Subject ${index}` }));
  const teachers = Array.from({ length: teacherCount }, (_, index) => ({ id: `t${index}`, name: `Teacher ${index}`, subjectIds: eligibility?.[index] ?? subjects.map((item) => item.id), availableSlots: [...(typeof teacherSlots === "function" ? teacherSlots(index) : teacherSlots)] }));
  const rooms = Array.from({ length: roomCount }, (_, index) => ({ id: `r${index}`, name: `Room ${index}`, availableSlots: [...(typeof roomSlots === "function" ? roomSlots(index) : roomSlots)] }));
  const batches = Array.from({ length: batchCount }, (_, index) => ({ id: `b${index}`, name: `Batch ${index}`, availableSlots: [...(typeof batchSlots === "function" ? batchSlots(index) : batchSlots)], requirements: subjects.map((subject) => ({ id: `q${index}-${subject.id}`, subjectId: subject.id, weeklySessions: sessions })) }));
  return normalizeDomain({ subjects, teachers, rooms, batches });
}

const firstTen = ALL_SLOTS.slice(0, 10);
const cases = [
  { label: "small-feasible", expected: true, setup: { batchCount: 2, subjectCount: 3, sessions: 2, teacherCount: 4, roomCount: 3 } },
  { label: "moderate-feasible", expected: true, setup: { batchCount: 8, subjectCount: 6, sessions: 2, teacherCount: 12, roomCount: 8 } },
  { label: "resource-tight-feasible", expected: true, maxNodes: 25_000, setup: { batchCount: 5, subjectCount: 5, sessions: 2, teacherCount: 7, roomCount: 4, batchSlots: ALL_SLOTS.slice(0, 13), teacherSlots: ALL_SLOTS.slice(0, 13), roomSlots: ALL_SLOTS.slice(0, 13) } },
  { label: "insufficient-batch-slots", expected: false, setup: { batchCount: 1, subjectCount: 1, sessions: 2, teacherCount: 1, roomCount: 1, batchSlots: [ALL_SLOTS[0]] } },
  { label: "missing-eligible-teacher", expected: false, setup: { batchCount: 1, subjectCount: 1, sessions: 1, teacherCount: 1, roomCount: 1, eligibility: [[]] } },
  { label: "availability-requirement-conflict", expected: false, setup: { batchCount: 1, subjectCount: 1, sessions: 2, teacherCount: 1, roomCount: 1, batchSlots: firstTen, teacherSlots: [ALL_SLOTS[0]], roomSlots: firstTen } },
  { label: "hard-rules-conflict", expected: false, setup: { batchCount: 1, subjectCount: 1, sessions: 1, teacherCount: 1, roomCount: 1 }, rules: ALL_SLOTS.filter((slot) => slot.endsWith("|9-10")).map((slot) => ({ type: "keep_day_free", priority: "hard", batch: "Batch 0", day: slot.split("|")[0], validation: "ready" })) },
  { label: "near-boundary", expected: true, setup: { batchCount: 1, subjectCount: 1, sessions: 10, teacherCount: 1, roomCount: 1, batchSlots: firstTen, teacherSlots: firstTen, roomSlots: firstTen } },
];

const warmups = Number(process.env.BENCH_WARMUPS || 1);
const repeats = Number(process.env.BENCH_REPEATS || 9);
const selectedCases = process.env.BENCH_CASE ? cases.filter((item) => item.label === process.env.BENCH_CASE) : cases;
const variants = (process.env.BENCH_VARIANTS || "production").split(",").map((name) => ({
  name,
  candidateOrdering: ["least_loaded", "combined"].includes(name) ? "least_loaded" : name === "production" ? "adaptive" : "stable",
  forwardChecking: name === "production" ? "adaptive" : ["forward_check", "combined"].includes(name),
}));
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(p * values.length) - 1)];
const results = [];
for (const benchmark of selectedCases) for (const variant of variants) {
  const domain = fixture(benchmark.setup);
  const samples = [];
  let latest;
  for (let run = 0; run < warmups + repeats; run += 1) {
    latest = generateTimetable(domain, { rules: benchmark.rules || [], candidateOrdering: variant.candidateOrdering, forwardChecking: variant.forwardChecking, ...(benchmark.maxNodes ? { maxNodes: benchmark.maxNodes } : {}) });
    if (run >= warmups) samples.push(latest.stats.elapsedMs);
  }
  const validation = latest.ok ? validateTimetable(latest.timetable, domain, { rules: benchmark.rules || [] }) : null;
  results.push({
    label: benchmark.label,
    variant: variant.name,
    size: {
      batches: domain.batches.length,
      teachers: domain.teachers.length,
      rooms: domain.rooms.length,
      totalSlots: ALL_SLOTS.length,
      availableSlotsMin: Math.min(...domain.batches.map((item) => new Set(item.availableSlots).size)),
      availableSlotsMax: Math.max(...domain.batches.map((item) => new Set(item.availableSlots).size)),
      requiredAssignments: benchmark.setup.batchCount * benchmark.setup.subjectCount * benchmark.setup.sessions,
    },
    expectedFeasible: benchmark.expected,
    nodeBudget: benchmark.maxNodes ?? 1_000_000,
    outcome: latest.status,
    expectedOutcome: latest.ok === benchmark.expected,
    medianMs: Number(percentile(samples, 0.5).toFixed(2)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(2)),
    nodes: latest.stats.nodes,
    backtracks: latest.stats.backtracks ?? 0,
    candidateChecks: latest.stats.candidateChecks ?? 0,
    rejectedCandidates: latest.stats.rejectedCandidates ?? 0,
    forwardChecks: latest.stats.forwardChecks ?? 0,
    forwardPrunes: latest.stats.forwardPrunes ?? 0,
    maxDepth: latest.stats.maxDepth ?? 0,
    validator: validation ? (validation.valid ? "pass" : "fail") : "not_applicable",
    diagnostic: latest.diagnostics[0]?.code ?? null,
  });
}
console.log(JSON.stringify({ runtime: { node: process.version, platform: `${os.platform()} ${os.release()}`, arch: os.arch(), cpu: os.cpus()[0]?.model || "unknown", logicalCpus: os.cpus().length, warmups, repeats }, results }, null, 2));
