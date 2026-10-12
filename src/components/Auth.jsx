import { useState } from "react";

export default function Auth({ onLogin }) {
  const [form, setForm] = useState({ email: "", password: "" }); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault(); setError(""); setBusy(true);
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify(form) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Authentication failed."); onLogin(data.user, data.csrfToken);
    } catch (cause) { setError(cause instanceof TypeError ? "Authentication service is unavailable. Start the API and try again." : cause.message); }
    finally { setBusy(false); }
  }
  return <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900"><form onSubmit={submit} className="bg-slate-800 border border-slate-700 p-6 rounded-xl w-80 space-y-4 shadow-xl">
    <h2 className="text-2xl font-bold text-center text-slate-100">Sign in</h2>
    <input required type="email" maxLength={254} autoComplete="email" placeholder="Email" className="input w-full" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}/>
    <input required type="password" maxLength={72} autoComplete="current-password" placeholder="Password" className="input w-full" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })}/>
    {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
    <button disabled={busy} className="bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white w-full py-2 rounded">{busy ? "Signing in…" : "Sign in"}</button>
    <p className="text-xs text-slate-400">Accounts are provisioned by an administrator.</p>
  </form></div>;
}
