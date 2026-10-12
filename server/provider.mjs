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

function safeField(value, limit = 120) {
  return typeof value === "string" && value.length ? value.slice(0, limit) : undefined;
}

function providerFailureMessage(status, code) {
  if (status === 400) return "The AI provider rejected the request or structured-output schema. Check OPENAI_MODEL and the provider diagnostic in Render logs.";
  if (status === 401) return "The AI provider rejected OPENAI_API_KEY. Check that the key is valid and belongs to the intended API project.";
  if (status === 403) return "The AI provider denied access. Check your API project permissions and access to the configured model.";
  if (status === 404) return "The configured AI endpoint or model was not found. Check OPENAI_API_URL and OPENAI_MODEL.";
  if (status === 429 && ["insufficient_quota", "billing_not_active", "quota_exceeded"].includes(code)) return "The AI API quota or billing limit was reached. Check API billing and usage limits.";
  if (status === 429) return "The AI provider rate limit was reached. Wait briefly and try again.";
  if (status >= 500) return "The AI provider is temporarily unavailable. Try again shortly.";
  return "The AI provider could not interpret this request. Check the provider diagnostic in Render logs.";
}

export async function interpretRequest(input, { apiKey = process.env.OPENAI_API_KEY, apiUrl = process.env.OPENAI_API_URL || "https://api.openai.com/v1/chat/completions", model = process.env.OPENAI_MODEL || "gpt-4o-mini", fetchImpl = fetch } = {}) {
  if (!apiKey) return { status: 503, body: { error: "AI is not configured. Set OPENAI_API_KEY on the server to enable interpretation." } };

  const usesOpenRouter = (() => { try { return new URL(apiUrl).hostname === "openrouter.ai"; } catch { return false; } })();
  let response;
  try {
    response = await fetchImpl(apiUrl, {
      method: "POST", signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...(usesOpenRouter ? { "HTTP-Referer": "https://schedulify-portfolio-demo.onrender.com", "X-Title": "Schedulify" } : {}) },
      body: JSON.stringify({ model, temperature: 0, stream: false,
        response_format: usesOpenRouter ? { type: "json_object" } : { type: "json_schema", json_schema: { name: "timetable_requirements", strict: true, schema: outputSchema } },
        messages: [
          { role: "system", content: `Return valid JSON only, with no Markdown or code fences. Output one JSON object with exactly these top-level keys: summary (string), rules (array), and nextSteps (array). Every rule object must include type, priority, batch, teacher, subject, room, day, period, explanation, validation, and clarification. Use JSON null for every unspecified resource filter. Interpret the scheduling request according to this contract. Supported types: keep_day_free, prefer_subject_before_lunch, avoid_teacher_consecutive. For an unhandled scheduling rule, use type unsupported and explain it. Days are ${days.join(", ")}. Batches are in the supplied catalogue. Slots group into morning (9-10, 10-11, 11-12) and afternoon (2-3, 3-4); preserve a morning/afternoon scope when stated, otherwise use null. Do not invent custom slots. Use null for every unspecified resource filter. Treat phrases such as any, all, all batches, or all teachers as no specific resource filter rather than literal names; never put words such as any or all into batch, teacher, subject, or room fields. Unknown or ambiguous named references require clarification; never guess. Mark rules ready only when the request is clear and every referenced named resource appears in the supplied catalogue. Do not claim that rules have been or can be enforced.` },
          { role: "user", content: JSON.stringify(input) },
        ],
      }),
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    console.error("Copilot provider transport failure", JSON.stringify({ kind: timedOut ? "timeout" : "network_error", name: safeField(error?.name), code: safeField(error?.code) }));
    return { status: 502, body: { error: timedOut ? "The AI provider request timed out. Try again shortly." : "Could not connect to the AI provider. Check the provider endpoint and Render logs." } };
  }

  const requestId = safeField(response.headers?.get?.("x-request-id"));
  if (!response.ok) {
    let upstreamError = {};
    try { upstreamError = (await response.json())?.error || {}; } catch { /* Some proxies return non-JSON errors. */ }
    const details = {
      status: Number(response.status) || 502,
      type: safeField(upstreamError.type),
      code: safeField(upstreamError.code),
      param: safeField(upstreamError.param),
      requestId,
    };
    console.error("Copilot provider HTTP failure", JSON.stringify(details));
    return { status: 502, body: { error: providerFailureMessage(details.status, details.code) } };
  }

  let payload;
  let responseText = "";
  const contentType = safeField(response.headers?.get?.("content-type"));
  const responseRequestId = safeField(response.headers?.get?.("x-request-id"))
    || safeField(response.headers?.get?.("x-openrouter-request-id"))
    || requestId;
  try {
    responseText = await response.text();
    payload = JSON.parse(responseText);
  } catch {
    const details = {
      status: Number(response.status) || 502,
      contentType,
      requestId: responseRequestId,
      bodyKind: /^\s*</.test(responseText) ? "html_or_markup" : responseText.length ? "non_json_text" : "empty",
      bodyLength: responseText.length,
    };
    console.error("Copilot provider returned invalid response JSON", JSON.stringify(details));
    const responseDescription = `HTTP ${details.status}${contentType ? ` (${contentType})` : ""}`;
    return { status: 502, body: { error: `The AI provider returned a non-JSON response: ${responseDescription}. Check OPENAI_API_URL and Render logs.` } };
  }
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    console.error("Copilot provider returned empty structured output", JSON.stringify({ requestId, hasChoices: Array.isArray(payload.choices) }));
    return { status: 502, body: { error: "The AI provider returned an empty interpretation. Try again or check Render logs." } };
  }

  let raw;
  try {
    raw = JSON.parse(content);
  } catch {
    console.error("Copilot provider returned malformed structured output", JSON.stringify({ requestId }));
    return { status: 502, body: { error: "The AI provider returned malformed structured data. Try again or check Render logs." } };
  }

  const validated = interpretationSchema.safeParse(raw);
  if (!validated.success) {
    console.error("Copilot structured output failed local schema validation", JSON.stringify({ requestId, issueCount: validated.error.issues.length }));
    return { status: 502, body: { error: "The AI provider returned an unsupported interpretation format. Check Render logs for details." } };
  }
  return { status: 200, body: validateReferences(validated.data, input.catalog) };
}
