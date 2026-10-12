import { interpretationSchema, validateReferences } from "./copilot-schema.mjs";

const days = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const outputSchema = {
  type: "object", additionalProperties: false, required: ["summary", "rules", "nextSteps"],
  properties: {
    summary: { type: "string" }, nextSteps: { type: "array", items: { type: "string" } },
    rules: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["type", "priority", "batch", "teacher", "subject", "room", "day", "period", "explanation", "validation", "clarification"],
      properties: {
        type: { type: "string", enum: ["keep_day_free", "prefer_subject_before_lunch", "avoid_teacher_consecutive", "unsupported"] },
        priority: { type: "string", enum: ["hard", "soft"] },
        batch: { type: ["string", "null"] }, teacher: { type: ["string", "null"] }, subject: { type: ["string", "null"] }, room: { type: ["string", "null"] },
        day: { type: ["string", "null"], enum: [...days, null] },
        period: { type: ["string", "null"], enum: ["morning", "afternoon", null] },
        explanation: { type: "string" }, validation: { type: "string", enum: ["ready", "needs_clarification", "unsupported"] }, clarification: { type: ["string", "null"] },
      } } },
  },
};

export async function interpretRequest(input, { apiKey = process.env.OPENAI_API_KEY, apiUrl = process.env.OPENAI_API_URL || "https://api.openai.com/v1/chat/completions", model = process.env.OPENAI_MODEL || "gpt-4o-mini", fetchImpl = fetch } = {}) {
  if (!apiKey) return { status: 503, body: { error: "AI is not configured. Set OPENAI_API_KEY on the server to enable interpretation." } };
  try {
    const response = await fetchImpl(apiUrl, {
      method: "POST", signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, temperature: 0,
        response_format: { type: "json_schema", json_schema: { name: "timetable_requirements", strict: true, schema: outputSchema } },
        messages: [
          { role: "system", content: `Interpret scheduling requests into the schema only. Supported types: keep_day_free, prefer_subject_before_lunch, avoid_teacher_consecutive. For an unhandled scheduling rule, use type unsupported and explain it. Days are ${days.join(", ")}. Batches are in the supplied catalogue. Slots group into morning (9-10, 10-11, 11-12) and afternoon (2-3, 3-4); preserve a morning/afternoon scope when stated, otherwise use null. Do not invent custom slots. Unknown or ambiguous references require clarification; never guess. Mark rules ready only when the request is clear and every referenced resource appears in the supplied catalogue. Do not claim that rules have been or can be enforced.` },
          { role: "user", content: JSON.stringify(input) },
        ],
      }),
    });
    if (!response.ok) return { status: 502, body: { error: "The AI provider could not interpret this request. Please try again." } };
    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content;
    if (!content) return { status: 502, body: { error: "The AI provider returned an empty interpretation." } };
    let raw;
    try { raw = JSON.parse(content); } catch { return { status: 502, body: { error: "The AI provider returned malformed structured data." } }; }
    const validated = interpretationSchema.safeParse(raw);
    if (!validated.success) return { status: 502, body: { error: "The AI provider returned an invalid interpretation." } };
    return { status: 200, body: validateReferences(validated.data, input.catalog) };
  } catch (error) {
    const timeout = error.name === "TimeoutError" || error.name === "AbortError";
    return { status: 502, body: { error: timeout ? "The AI request timed out. Please try again." : "The AI provider is temporarily unavailable." } };
  }
}
