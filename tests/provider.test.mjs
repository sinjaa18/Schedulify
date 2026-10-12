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
  assert.match(result.body.error, /OPENAI_API_KEY/);
});

test("uses mocked structured output and validates the result", async () => {
  let sent;
  const result = await interpretRequest(input, { apiKey: "test-key", fetchImpl: async (_url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true, headers: { get: () => "req_test_123" }, json: async () => ({ choices: [{ message: { content: JSON.stringify(structured) } }] }) };
  } });
  assert.equal(sent.response_format.type, "json_schema");
  assert.equal(result.status, 200);
  assert.equal(result.body.result.rules[0].validation, "ready");
});

test("explains authentication errors and logs only safe provider metadata", async () => {
  const original = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(" "));
  let result;
  try {
    result = await interpretRequest(input, { apiKey: "secret-test-key", fetchImpl: async () => ({
      ok: false, status: 401,
      headers: { get: (name) => name === "x-request-id" ? "req_test_123" : null },
      json: async () => ({ error: { type: "authentication_error", code: "invalid_api_key", message: "secret diagnostic text" } }),
    }) });
  } finally { console.error = original; }
  assert.equal(result.status, 502);
  assert.match(result.body.error, /OPENAI_API_KEY/);
  assert.doesNotMatch(JSON.stringify(result.body), /secret diagnostic text|secret-test-key/);
  assert.match(logs.join(" "), /invalid_api_key/);
  assert.match(logs.join(" "), /req_test_123/);
  assert.doesNotMatch(logs.join(" "), /secret diagnostic text|secret-test-key/);
});

test("distinguishes quota errors from request-schema errors", async () => {
  const call = (status, code) => interpretRequest(input, { apiKey: "test-key", fetchImpl: async () => ({
    ok: false, status, headers: { get: () => null }, json: async () => ({ error: { type: "invalid_request_error", code } }),
  }) });
  const quota = await call(429, "insufficient_quota");
  assert.match(quota.body.error, /quota or billing limit/);
  const schema = await call(400, "invalid_json_schema");
  assert.match(schema.body.error, /structured-output schema/);
});

test("handles transport failures and malformed output", async () => {
  const network = await interpretRequest(input, { apiKey: "test-key", fetchImpl: async () => { throw Object.assign(new TypeError("Failed to fetch"), { code: "ECONNRESET" }); } });
  assert.equal(network.status, 502);
  assert.match(network.body.error, /connect to the AI provider/);
  const malformed = await interpretRequest(input, { apiKey: "test-key", fetchImpl: async () => ({ ok: true, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content: "not json" } }] }) }) });
  assert.equal(malformed.status, 502);
  assert.match(malformed.body.error, /malformed structured data/);
});
