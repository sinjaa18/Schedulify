import test from "node:test";
import assert from "node:assert/strict";
import { interpretRequest } from "../server/provider.mjs";

const input = { request: "Prefer mathematics before lunch.", catalog: { teachers: [], subjects: ["Mathematics"], rooms: [], batches: [] } };
const structured = { summary: "A morning preference.", rules: [{
  type: "prefer_subject_before_lunch", priority: "soft", batch: null, teacher: null,
  subject: "Mathematics", room: null, day: null, period: "morning", explanation: "Prefer Mathematics before lunch.",
  validation: "ready", clarification: null,
}], nextSteps: [] };

test("reports missing provider credentials", async () => {
  const result = await interpretRequest(input, { apiKey: "" });
  assert.equal(result.status, 503);
});

test("uses mocked structured output and validates the result", async () => {
  let sent;
  const result = await interpretRequest(input, { apiKey: "test-key", fetchImpl: async (_url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(structured) } }] }) };
  } });
  assert.equal(sent.response_format.type, "json_schema");
  assert.equal(result.status, 200);
  assert.equal(result.body.result.rules[0].validation, "ready");
});

test("handles provider errors and malformed structured output", async () => {
  const failed = await interpretRequest(input, { apiKey: "test-key", fetchImpl: async () => ({ ok: false }) });
  assert.equal(failed.status, 502);
  const malformed = await interpretRequest(input, { apiKey: "test-key", fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "not json" } }] }) }) });
  assert.equal(malformed.status, 502);
});
