import { useEffect, useState } from "react";
import { ALL_SLOTS, createId } from "../utils/domain";
import AdminAccounts from "./AdminAccounts";

export default function AdminPanel({ rooms: initialRooms, subjects: initialSubjects, teachers: initialTeachers, batches: initialBatches, onSave, onGenerate, generationResult, csrfToken }) {
  const [rooms, setRooms] = useState(initialRooms); const [subjects, setSubjects] = useState(initialSubjects);
  const [teachers, setTeachers] = useState(initialTeachers); const [batches, setBatches] = useState(initialBatches);
  const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { setRooms(initialRooms); setSubjects(initialSubjects); setTeachers(initialTeachers); setBatches(initialBatches); }, [initialRooms, initialSubjects, initialTeachers, initialBatches]);
  const [roomName, setRoomName] = useState("");
  const [teacherName, setTeacherName] = useState("");
  const [subjectName, setSubjectName] = useState("");
  const [batchName, setBatchName] = useState("");
  const [requirementDraft, setRequirementDraft] = useState({});

  const addNamed = (value, setter, prefix, extra = {}) => {
    const name = value.trim();
    if (!name) return;
    setter((items) => [...items, { id: createId(prefix), name, ...(prefix === "subject" ? {} : { availableSlots: [...ALL_SLOTS] }), ...extra }]);
  };
  const toggleAvailability = (setter, resource, value) => setter((items) => items.map((item) => item.id !== resource.id ? item : {
    ...item, availableSlots: item.availableSlots.includes(value) ? item.availableSlots.filter((slot) => slot !== value) : [...item.availableSlots, value],
  }));

  function addRequirement(batch) {
    const draft = requirementDraft[batch.id] || {};
    const weeklySessions = Number(draft.weeklySessions ?? 1);
    if (!draft.subjectId || !Number.isInteger(weeklySessions) || weeklySessions < 1) return;
    setBatches((items) => items.map((item) => item.id !== batch.id ? item : {
      ...item, requirements: item.requirements.some((entry) => entry.subjectId === draft.subjectId)
        ? item.requirements.map((entry) => entry.subjectId === draft.subjectId ? { ...entry, weeklySessions } : entry)
        : [...item.requirements, { id: createId("requirement"), subjectId: draft.subjectId, weeklySessions }],
    }));
    setRequirementDraft((items) => ({ ...items, [batch.id]: { ...items[batch.id], weeklySessions: 1 } }));
  }

  async function save() { setBusy(true); setMessage(""); try { await onSave({ batches, subjects, teachers, rooms }); setMessage("Scheduling data saved to the server."); } catch (error) { setMessage(error.message); } finally { setBusy(false); } }
  async function generate() { setBusy(true); setMessage(""); try { const result = await onGenerate(); setMessage(result.ok ? "Validated candidate stored on the server." : `Generation ended: ${result.status || "no solution"}.`); } catch (error) { const result = error.data; const detail = result?.diagnostics?.map((item) => item.message).filter(Boolean).join("; "); setMessage(`${error.message}${result?.status ? ` (${result.status})` : ""}${detail ? ` — ${detail}` : ""}`); } finally { setBusy(false); } }
  function exportLegacy() {
    const keys = ["classrooms", "subjects", "teachers", "batches", "timetable", "approved", "copilotRequirements"];
    const legacy = Object.fromEntries(keys.filter((key) => localStorage.getItem(key) !== null).map((key) => [key, JSON.parse(localStorage.getItem(key))]));
    const blob = new Blob([JSON.stringify({ format: "schedulify-legacy-export-v1", exportedAt: new Date().toISOString(), data: legacy }, null, 2)], { type: "application/json" });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "schedulify-legacy-export.json"; link.click(); URL.revokeObjectURL(link.href);
  }

  return <div className="space-y-6">
    <header><h2 className="text-3xl font-bold">Admin Panel</h2><p className="mt-1 text-slate-400">Configure resources, explicit subject eligibility, batch-specific weekly requirements, then generate and independently validate a candidate.</p></header>
    <AdminAccounts csrfToken={csrfToken} />
    <button onClick={exportLegacy} className="rounded border border-amber-500/50 px-3 py-2 text-sm text-amber-200">Export this browser’s legacy data</button>
    <p className="text-xs text-slate-400">Export preserves browser data for review. Legacy timetables, approval flags, and unverified Copilot rules are not imported automatically.</p>
    <div className="flex gap-3"><button disabled={busy} onClick={save} className="btn">{busy ? "Saving…" : "Save scheduling data"}</button><button disabled={busy} onClick={generate} className="rounded-lg bg-green-600 px-5 py-2 font-semibold">Generate candidate</button></div>
    {message && <p role="status" className="text-sm text-teal-200">{message}</p>}
    <div className="grid gap-4 md:grid-cols-2">
      <Block title="Rooms"><div className="flex gap-2"><input aria-label="Room name" placeholder="Room name" value={roomName} onChange={(e) => setRoomName(e.target.value)} className="input min-w-0 flex-1"/><button className="btn" onClick={() => { addNamed(roomName, setRooms, "room"); setRoomName(""); }}>Add room</button></div><ResourceList items={rooms} setter={setRooms} toggle={toggleAvailability} /></Block>
      <Block title="Teachers"><div className="flex gap-2"><input aria-label="Teacher name" placeholder="Teacher name" value={teacherName} onChange={(e) => setTeacherName(e.target.value)} className="input min-w-0 flex-1"/><button className="btn" onClick={() => { addNamed(teacherName, setTeachers, "teacher", { subjectIds: [] }); setTeacherName(""); }}>Add teacher</button></div>
        <p className="text-xs text-amber-200">Teachers are not eligible for any subject until you select it below.</p>
        <div className="space-y-3">{teachers.map((teacher) => <details key={teacher.id} className="rounded-lg bg-slate-900 p-3"><summary className="cursor-pointer font-medium">{teacher.name} · {teacher.subjectIds.length} eligible subject(s)</summary><div className="mt-2 flex gap-2"><input aria-label={`${teacher.name} name`} className="input" value={teacher.name} onChange={(e) => setTeachers((items) => items.map((item) => item.id === teacher.id ? { ...item, name: e.target.value } : item))}/><button className="text-rose-300" onClick={() => setTeachers((items) => items.filter((item) => item.id !== teacher.id))}>Remove teacher</button></div><fieldset className="mt-3"><legend className="text-xs text-slate-400">Eligible to teach</legend><div className="mt-2 flex flex-wrap gap-3">{subjects.map((subject) => <label key={subject.id} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={teacher.subjectIds.includes(subject.id)} onChange={(e) => { setTeachers((items) => items.map((item) => item.id !== teacher.id ? item : { ...item, subjectIds: e.target.checked ? [...new Set([...item.subjectIds, subject.id])] : item.subjectIds.filter((id) => id !== subject.id) })); }}/>{subject.name}</label>)}</div></fieldset><Availability resource={teacher} toggle={(value) => { toggleAvailability(setTeachers, teacher, value); }} /></details>)}</div>
      </Block>
      <Block title="Subjects"><div className="flex gap-2"><input aria-label="Subject name" placeholder="Subject name" value={subjectName} onChange={(e) => setSubjectName(e.target.value)} className="input min-w-0 flex-1"/><button className="btn" onClick={() => { addNamed(subjectName, setSubjects, "subject"); setSubjectName(""); }}>Add subject</button></div><ul className="space-y-2">{subjects.map((subject) => <li key={subject.id} className="flex items-center gap-2 rounded-lg bg-slate-900 p-3"><input aria-label={`${subject.name} name`} className="input flex-1" value={subject.name} onChange={(e) => setSubjects((items) => items.map((item) => item.id === subject.id ? { ...item, name: e.target.value } : item))}/>{subject.minPerWeek ? <span className="text-xs text-slate-400">Legacy {subject.minPerWeek}/week</span> : null}<button className="text-rose-300" onClick={() => setSubjects((items) => items.filter((item) => item.id !== subject.id))}>Remove</button></li>)}</ul></Block>
      <Block title="Student batches"><div className="flex gap-2"><input aria-label="Batch name" placeholder="e.g. Grade 10-A" value={batchName} onChange={(e) => setBatchName(e.target.value)} className="input min-w-0 flex-1"/><button className="btn" onClick={() => { addNamed(batchName, setBatches, "batch", { requirements: [] }); setBatchName(""); }}>Add batch</button></div><div className="space-y-4">{batches.map((batch) => <section key={batch.id} className="rounded-lg bg-slate-900 p-3"><div className="flex gap-2"><input aria-label={`${batch.name} name`} className="input flex-1" value={batch.name} onChange={(e) => setBatches((items) => items.map((item) => item.id === batch.id ? { ...item, name: e.target.value } : item))}/><button className="text-rose-300" onClick={() => setBatches((items) => items.filter((item) => item.id !== batch.id))}>Remove batch</button></div><div className="mt-2 space-y-1">{batch.requirements.map((requirement) => <div key={requirement.id} className="flex items-center justify-between gap-2 text-sm"><span>{subjects.find((subject) => subject.id === requirement.subjectId)?.name || "Unknown subject"} · {requirement.weeklySessions}/week</span><button className="text-rose-300" aria-label={`Remove requirement from ${batch.name}`} onClick={() => { setBatches((items) => items.map((item) => item.id !== batch.id ? item : { ...item, requirements: item.requirements.filter((entry) => entry.id !== requirement.id) })); }}>Remove</button></div>)}</div><div className="mt-3 flex flex-wrap gap-2"><select aria-label={`${batch.name} subject`} className="input" value={requirementDraft[batch.id]?.subjectId || ""} onChange={(e) => setRequirementDraft((items) => ({ ...items, [batch.id]: { ...items[batch.id], subjectId: e.target.value } }))}><option value="">Choose subject</option>{subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}</select><input aria-label={`${batch.name} weekly sessions`} className="input w-28" type="number" min="1" max="25" value={requirementDraft[batch.id]?.weeklySessions ?? 1} onChange={(e) => setRequirementDraft((items) => ({ ...items, [batch.id]: { ...items[batch.id], weeklySessions: e.target.value } }))}/><button className="btn" onClick={() => addRequirement(batch)}>Add weekly requirement</button></div><Availability resource={batch} toggle={(value) => { toggleAvailability(setBatches, batch, value); }} /></section>)}</div></Block>
    </div>
    {generationResult && <section role="status" className="rounded-xl border border-slate-700 p-4"><h3 className="font-semibold">Server timetable · {generationResult.status}</h3><p className="text-sm text-slate-300">Source revision {generationResult.sourceRevision} · {generationResult.timetable?.length || 0} sessions</p>{generationResult.stats && <p className="text-xs text-slate-400">{generationResult.stats.nodes} search nodes · {generationResult.stats.elapsedMs?.toFixed?.(2)} ms</p>}<ul className="list-inside list-disc text-sm">{(generationResult.diagnostics || []).map((item, index) => <li key={index}>{item.message}</li>)}</ul></section>}
  </div>;
}

function ResourceList({ items, setter, toggle }) { return <div className="space-y-2">{items.map((item) => <details key={item.id} className="rounded-lg bg-slate-900 p-3"><summary className="cursor-pointer">{item.name}</summary><div className="mt-2 flex gap-2"><input aria-label={`${item.name} name`} className="input" value={item.name} onChange={(e) => setter((rows) => rows.map((row) => row.id === item.id ? { ...row, name: e.target.value } : row))}/><button className="text-rose-300" onClick={() => setter((rows) => rows.filter((row) => row.id !== item.id))}>Remove</button></div><Availability resource={item} toggle={(value) => { toggle(setter, item, value); }}/></details>)}</div>; }
function Availability({ resource, toggle }) { return <details className="mt-2 text-xs text-slate-400"><summary className="cursor-pointer">Availability · {resource.availableSlots.length}/25 slots</summary><div className="mt-2 grid grid-cols-2 gap-1 sm:grid-cols-3">{ALL_SLOTS.map((value) => <label key={value} className="flex items-center gap-1"><input type="checkbox" checked={resource.availableSlots.includes(value)} onChange={() => toggle(value)}/>{value.replace("|", " ")}</label>)}</div></details>; }
function Block({ title, children }) { return <section className="space-y-3 rounded-xl border border-slate-700 bg-slate-800 p-4"><h3 className="font-semibold">{title}</h3>{children}</section>; }
