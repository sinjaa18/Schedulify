import { useState } from "react";
import TimetableView from "./TimetableView";

export default function HODPanel({ versions = [], timetable, csrfToken, onRefresh }) {
  const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  async function transition(action) {
    if (!timetable?.id) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/timetables/${timetable.id}/${action}`, { method: "POST", credentials: "same-origin", headers: { "x-csrf-token": csrfToken } });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Could not update timetable status.");
      setMessage(action === "approve" ? "Timetable published." : "Candidate rejected."); await onRefresh();
    } catch (error) { setMessage(error.message); await onRefresh(); } finally { setBusy(false); }
  }
  return <div className="space-y-4"><h2 className="text-3xl font-bold">HOD Review</h2>
    {message && <p role="status" className="rounded bg-slate-800 p-3 text-sm">{message}</p>}
    <section className="rounded-xl border border-slate-700 bg-slate-800 p-4"><h3 className="font-semibold">Timetable versions</h3><ul className="mt-2 space-y-2 text-sm">{versions.map((item) => <li key={item.id}><span>{item.status} · revision {item.sourceRevision} · {new Date(item.createdAt).toLocaleString()}</span>{item.validation && <span className="ml-2 text-slate-400">validator {item.validation.valid ? "passed" : "failed"}</span>}{item.diagnostics?.length > 0 && <ul className="ml-5 list-disc text-xs text-slate-400">{item.diagnostics.slice(0, 3).map((d, index) => <li key={index}>{d.message}</li>)}</ul>}</li>)}</ul></section>
    {!timetable ? <p className="text-slate-400">No candidate or published timetable is available.</p> : <>
      <section className="rounded-xl border border-slate-700 bg-slate-800 p-4"><h3 className="font-semibold">{timetable.status} · revision {timetable.sourceRevision}</h3>
        <p className="mt-1 text-sm">Independent validation: {timetable.validation?.valid ? "passed" : "failed"}</p>
        {timetable.validation?.violations?.length > 0 && <ul className="mt-2 list-inside list-disc text-sm">{timetable.validation.violations.map((item, i) => <li key={i}>{item.message}</li>)}</ul>}
        {timetable.status === "candidate" && <div className="mt-3 flex gap-2"><button disabled={busy || !timetable.validation?.valid} onClick={() => transition("approve")} className="rounded bg-green-600 px-4 py-2 disabled:opacity-50">Approve and publish</button><button disabled={busy} onClick={() => transition("reject")} className="rounded bg-rose-700 px-4 py-2 disabled:opacity-50">Reject</button></div>}
      </section><TimetableView timetable={timetable.timetable || []}/>
    </>}
  </div>;
}
