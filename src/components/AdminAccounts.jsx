import { useEffect, useState } from "react";

const roles = ["Admin", "HOD", "Teacher", "Student"];
const emptyForm = { name: "", email: "", password: "", role: "Teacher" };

export default function AdminAccounts({ csrfToken }) {
  const [users, setUsers] = useState([]);
  const [resources, setResources] = useState({ teachers: [], batches: [] });
  const [form, setForm] = useState(emptyForm);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function refresh() {
    const response = await fetch("/api/auth/users", { credentials: "same-origin", cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load accounts.");
    setUsers(data.users);
  }
  useEffect(() => { refresh().catch((error) => setMessage(error.message)); fetch("/api/domain", { credentials: "same-origin" }).then((r) => r.json()).then((d) => setResources({ teachers: d.domain?.teachers || [], batches: d.domain?.batches || [] })).catch(() => {}); }, []);
  async function provision(event) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/auth/users", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify(form) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not provision account.");
      setForm(emptyForm); setMessage(`Created ${data.user.role} account for ${data.user.email}.`); await refresh();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }
  async function changeRole(user, role) {
    setMessage("");
    try {
      const response = await fetch(`/api/auth/users/${user.id}/role`, { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify({ role }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not change role.");
      await refresh();
    } catch (error) { setMessage(error.message); await refresh().catch(() => {}); }
  }
  async function associate(user, key, value) {
    try {
      const payload = key === "teacherId" ? { teacherId: value || null } : { batchId: value || null };
      const response = await fetch(`/api/auth/users/${user.id}/association`, { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify(payload) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Could not update account linkage.");
      setMessage("Account linked to its scheduling record."); await refresh();
    } catch (error) { setMessage(error.message); await refresh().catch(() => {}); }
  }
  return <section className="rounded-xl border border-slate-700 bg-slate-800 p-4 space-y-4">
    <div><h3 className="text-xl font-semibold">Server accounts</h3><p className="text-sm text-slate-400">Provision roles here. The API validates every account and role change.</p></div>
    <form className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5" onSubmit={provision}>
      <input required maxLength={100} placeholder="Name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <input required type="email" maxLength={254} placeholder="Email" className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      <input required type="password" minLength={12} maxLength={72} autoComplete="new-password" placeholder="Temporary password (12–72)" className="input" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
      <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{roles.map((role) => <option key={role}>{role}</option>)}</select>
      <button disabled={busy} className="btn">{busy ? "Creating…" : "Create account"}</button>
    </form>
    {message && <p role="status" className="text-sm text-teal-200">{message}</p>}
    <ul className="divide-y divide-slate-700">{users.map((user) => <li key={user.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"><span>{user.name} · {user.email} · {user.status}</span><select aria-label={`Role for ${user.email}`} className="input" value={user.role} onChange={(e) => changeRole(user, e.target.value)}>{roles.map((role) => <option key={role}>{role}</option>)}</select>{user.role === "Teacher" && <select aria-label={`Teacher record for ${user.email}`} className="input" value={user.teacherId || ""} onChange={(e) => associate(user, "teacherId", e.target.value)}><option value="">Link teacher record…</option>{resources.teachers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}{user.role === "Student" && <select aria-label={`Student batch for ${user.email}`} className="input" value={user.batchId || ""} onChange={(e) => associate(user, "batchId", e.target.value)}><option value="">Assign batch…</option>{resources.batches.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}</li>)}</ul>
  </section>;
}
