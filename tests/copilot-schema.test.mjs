import test from "node:test";
import assert from "node:assert/strict";
import { interpretationSchema, validateReferences } from "../server/copilot-schema.mjs";

const known = { teachers: ["Anaya Sharma"], subjects: ["Mathematics"], rooms: ["Room 1"], batches: [] };
const rule = (overrides = {}) => ({
  type: "prefer_subject_before_lunch", priority: "soft", batch: null, teacher: null,
  subject: "Mathematics", room: null, day: null, period: "morning",
  explanation: "Prefer Mathematics before lunch.", validation: "ready", clarification: null, ...overrides,
});

test("accepts a well-formed interpretation and marks supported rules ready", () => {
  const parsed = interpretationSchema.parse({ summary: "A morning preference.", rules: [rule()], nextSteps: [] });
  const { result } = validateReferences(parsed, known);
  assert.equal(result.rules[0].validation, "ready");
});

test("rejects malformed and unsupported rule types", () => {
  assert.equal(interpretationSchema.safeParse({ summary: "No", rules: [{ ...rule(), type: "make_a_timetable" }], nextSteps: [] }).success, false);
  assert.equal(interpretationSchema.safeParse({ summary: "No", rules: [{ ...rule(), priority: "maybe" }], nextSteps: [] }).success, false);
});

test("unknown teacher, subject, room, and unavailable batch require clarification", () => {
  const parsed = interpretationSchema.parse({ summary: "Check references.", rules: [
    rule({ teacher: "Unknown Teacher" }), rule({ subject: "Unknown Subject" }),
    rule({ room: "Unknown Room" }), rule({ batch: "Grade 10-A" }),
  ], nextSteps: [] });
  const { result, errors } = validateReferences(parsed, known);
  assert.equal(result.rules.every((item) => item.validation === "needs_clarification"), true);
  assert.equal(errors.length, 4);
});

test("ambiguous interpretations can request clarification", () => {
  const parsed = interpretationSchema.parse({ summary: "A detail is missing.", rules: [rule({ validation: "needs_clarification", clarification: "Which Friday?" })], nextSteps: [] });
  assert.equal(parsed.rules[0].clarification, "Which Friday?");
});

test("unsupported interpreted requests remain explicitly unsupported", () => {
  const parsed = interpretationSchema.parse({ summary: "Lab room request.", rules: [rule({ type: "unsupported", validation: "unsupported", clarification: "No room type model." })], nextSteps: [] });
  const { result } = validateReferences(parsed, known);
  assert.equal(result.rules[0].validation, "unsupported");
});
test("normalizes wildcard Copilot references instead of treating them as resource names", () => {
  const parsed = interpretationSchema.parse({ summary: "Keep Friday afternoon free for all batches.", rules: [
    rule({ type: "keep_day_free", priority: "hard", batch: "all", teacher: "any", subject: "any", room: "any", day: "Fri", period: "afternoon", explanation: "Keep Friday afternoon free for all batches." }),
  ], nextSteps: [] });
  const { result, errors } = validateReferences(parsed, known);
  assert.equal(errors.length, 0);
  assert.equal(result.rules[0].validation, "ready");
  assert.equal(result.rules[0].clarification, null);
  assert.equal(result.rules[0].batch, null);
  assert.equal(result.rules[0].teacher, null);
  assert.equal(result.rules[0].subject, null);
  assert.equal(result.rules[0].room, null);
});
