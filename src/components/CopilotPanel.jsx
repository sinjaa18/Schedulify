import { useState } from "react";

const examples = [
  "Keep Friday afternoon free.",
  "Prefer mathematics classes before lunch.",
  "Avoid consecutive classes for teacher Anaya Sharma where possible.",
  "Explain why all required laboratory sessions may not fit.",
];

const label = {
  keep_day_free: "Keep a day free",
  prefer_subject_before_lunch: "Prefer subject before lunch",
  avoid_teacher_consecutive: "Avoid consecutive teacher classes",
  unsupported: "Unsupported scheduling request",
};

export default function CopilotPanel({ user, csrfToken, acceptedRules, onSaveRules }) {
  const [request, setRequest] = useState("");
  const [interpretation, setInterpretation] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const canUse = user?.role === "Admin";

  async function interpret() {
    setLoading(true); setError(""); setInterpretation(null); setConfirmed(false);
    try {
      const response = await fetch("/api/copilot/interpret", {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ request }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not interpret the request.");
      // The API wraps a successful interpretation in { result, errors }.
      // Accept both the wrapped server response and a direct interpretation.
      const parsed = data?.result ?? data;
      if (!parsed || typeof parsed.summary !== "string" || !Array.isArray(parsed.rules)) {
        throw new Error("The AI provider returned an unexpected response format. Please retry; your timetable remains unchanged.");
      }
      setInterpretation({
        summary: parsed.summary,
        rules: parsed.rules,
        nextSteps: Array.isArray(parsed.nextSteps) ? parsed.nextSteps : [],
      });
    } catch (err) { setError(err.message || "The AI service is unavailable."); }
    finally { setLoading(false); }
  }

  async function confirm() { try { await onSaveRules([...acceptedRules, ...interpretation.rules]); setConfirmed(true); } catch (cause) { setError(cause.message); } }

  if (!canUse) return <section className="max-w-3xl rounded-2xl border border-slate-700 bg-slate-800 p-6"><h2 className="text-2xl font-bold">Timetable Copilot</h2><p className="mt-3 text-slate-300">Only an administrator can interpret and confirm requirements. Access is enforced by the server.</p></section>;

  return <div className="mx-auto max-w-4xl space-y-6">
    <header><p className="text-sm font-semibold uppercase tracking-widest text-teal-400">Planning assistant</p><h2 className="mt-1 text-3xl font-bold">Timetable Copilot</h2><p className="mt-2 max-w-2xl text-slate-300">Describe a scheduling requirement. Copilot returns a checked interpretation for review; it does not write or validate a timetable.</p></header>
    <section className="rounded-2xl border border-slate-700 bg-slate-800 p-5 shadow-lg">
      <label htmlFor="copilot-request" className="mb-2 block font-semibold">What should the timetable account for?</label>
      <textarea id="copilot-request" value={request} maxLength={1000} onChange={(e) => setRequest(e.target.value)} placeholder="e.g. Keep Friday afternoon free for Grade 10-A" className="min-h-28 w-full resize-y rounded-xl border border-slate-600 bg-slate-900 p-3 text-slate-100 outline-none focus:border-teal-400" />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-slate-400">{request.length}/1000 characters</span><button disabled={loading || request.trim().length < 5} onClick={interpret} className="rounded-lg bg-teal-600 px-5 py-2.5 font-semibold text-white transition hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-50">{loading ? "Interpreting…" : "Interpret request"}</button></div>
      <div className="mt-5"><p className="mb-2 text-sm text-slate-400">Try an example</p><div className="flex flex-wrap gap-2">{examples.map((item) => <button key={item} onClick={() => { setRequest(item); setError(""); setInterpretation(null); }} className="rounded-full border border-slate-600 px-3 py-1.5 text-left text-sm text-slate-300 hover:border-teal-500 hover:text-white">{item}</button>)}</div></div>
    </section>

    {error && <div role="alert" className="rounded-xl border border-rose-500/40 bg-rose-950/40 p-4 text-rose-200">{error}<p className="mt-1 text-sm text-rose-200/80">Your timetable remains unchanged. You can continue using the regular Admin workflow.</p></div>}

    {interpretation && <section className="space-y-4 rounded-2xl border border-slate-700 bg-slate-800 p-5">
      <div><p className="text-sm font-semibold uppercase tracking-widest text-teal-400">Interpretation</p><p className="mt-2 text-slate-100">{interpretation.summary}</p></div>
      {interpretation.rules.length === 0 ? <p className="rounded-lg bg-slate-900 p-4 text-slate-300">No supported scheduling requirement was identified. Add detail or use a different request.</p> : <div className="space-y-3">{interpretation.rules.map((rule, i) => <article key={`${rule.type}-${i}`} className="rounded-xl border border-slate-700 bg-slate-900/70 p-4">
        <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{label[rule.type] || "Unrecognized rule"}</h3><span className={`rounded-full px-2.5 py-1 text-xs font-bold ${rule.priority === "hard" ? "bg-rose-400/15 text-rose-300" : "bg-sky-400/15 text-sky-300"}`}>{rule.priority === "hard" ? "Hard constraint" : "Soft preference"}</span><span className={`rounded-full px-2.5 py-1 text-xs ${rule.validation === "ready" ? "bg-emerald-400/15 text-emerald-300" : rule.validation === "unsupported" ? "bg-amber-400/15 text-amber-200" : "bg-orange-400/15 text-orange-200"}`}>{rule.validation === "ready" ? "References checked" : rule.validation === "unsupported" ? "Pending scheduler support" : "Needs clarification"}</span></div>
        <p className="mt-2 text-sm text-slate-300">{rule.explanation}</p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">{rule.day && <span>Day: {rule.day}</span>}{rule.period && <span>Period: {rule.period}</span>}{rule.subject && <span>Subject: {rule.subject}</span>}{rule.teacher && <span>Teacher: {rule.teacher}</span>}{rule.room && <span>Room: {rule.room}</span>}{rule.batch && <span>Batch: {rule.batch}</span>}</div>
        {rule.clarification && <p className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-100">{rule.clarification}</p>}
      </article>)}</div>}
      {interpretation.nextSteps?.length > 0 && <div className="rounded-xl bg-slate-900 p-4"><h3 className="font-semibold">Suggested next steps</h3><ul className="mt-2 list-inside list-disc space-y-1 text-sm text-slate-300">{interpretation.nextSteps.map((step, i) => <li key={i}>{step}</li>)}</ul></div>}
      <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-100"><strong>Scheduling behavior.</strong> Confirmed supported hard rules are enforced during the next generation. Soft rules rank valid placements and may be unmet. Confirmation leaves the current timetable unchanged; generation creates a new candidate that must pass independent validation.</div>
      <div className="flex flex-wrap items-center gap-3"><button onClick={confirm} disabled={confirmed || !interpretation.rules.length || interpretation.rules.some((rule) => rule.validation === "needs_clarification")} className="rounded-lg bg-teal-600 px-4 py-2 font-semibold text-white hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-50">Confirm requirements</button><span className="text-sm text-slate-400">Clarify unknown or ambiguous references before confirming.</span></div>
      {confirmed && <p role="status" className="rounded-lg bg-emerald-400/10 p-3 text-emerald-200">Requirements confirmed and added to the active rules ({acceptedRules.length}). The timetable was not changed.</p>}
    </section>}
    {acceptedRules.length > 0 && <section className="rounded-2xl border border-slate-700 bg-slate-800 p-5"><h3 className="font-semibold">Active confirmed rules ({acceptedRules.length})</h3><div className="mt-3 space-y-2">{acceptedRules.map((rule, index) => <div key={`${rule.type}-${index}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-900 p-3"><span className="text-sm">{rule.explanation} <span className="ml-1 text-xs text-slate-400">{rule.priority} · {rule.validation}</span></span><button className="text-sm text-rose-300 hover:text-rose-200" onClick={() => { onSaveRules(acceptedRules.filter((_, ruleIndex) => ruleIndex !== index)).catch((cause) => setError(cause.message)); }}>Remove</button></div>)}</div><p className="mt-3 text-xs text-slate-400">New confirmations are added to this list. Remove a rule here to exclude it from future generation.</p></section>}
  </div>;
}
