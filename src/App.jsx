import React, { useCallback, useEffect, useState } from "react";
import Auth from "./components/Auth";
import Sidebar from "./components/Sidebar";
import Dashboard from "./components/Dashboard";
import AdminPanel from "./components/AdminPanel";
import HODPanel from "./components/HODPanel";
import UserTimetablePanel from "./components/UserTimetablePanel";
import CopilotPanel from "./components/CopilotPanel";

const emptyDomain = { batches: [], subjects: [], teachers: [], rooms: [] };
async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...options });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || data.status || "Request failed."); error.status = response.status; error.data = data; throw error; }
  return data;
}

export default function App() {
  const [user, setUser] = useState(null); const [csrfToken, setCsrfToken] = useState("");
  const [authLoading, setAuthLoading] = useState(true); const [authUnavailable, setAuthUnavailable] = useState(false);
  const [logoutError, setLogoutError] = useState(""); const [page, setPage] = useState("dashboard");
  const [domain, setDomain] = useState(emptyDomain); const [rules, setRules] = useState([]); const [revision, setRevision] = useState(0);
  const [version, setVersion] = useState(null); const [versions, setVersions] = useState([]); const [ownSchedule, setOwnSchedule] = useState([]); const [loadError, setLoadError] = useState("");

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      if (["Admin", "HOD"].includes(user.role)) {
        const [data, list] = await Promise.all([api("/api/domain"), api("/api/timetables")]);
        setDomain(data.domain); setRules(data.rules); setRevision(data.revision); setVersions(list.versions);
        const current = list.versions.find((item) => item.status === "candidate") || list.versions.find((item) => item.status === "approved");
        setVersion(current ? await api(`/api/timetables/${current.id}`) : null);
      } else {
        const data = await api("/api/timetable/mine"); setOwnSchedule(data.timetable || []);
      }
      setLoadError("");
    } catch (error) { setLoadError(error.message); if (error.status === 401) { setUser(null); setCsrfToken(""); } }
  }, [user]);
  useEffect(() => {
    localStorage.removeItem("currentUser"); localStorage.removeItem("users");
    api("/api/auth/session").then((data) => { setUser(data.user); setCsrfToken(data.csrfToken); })
      .catch((error) => { if (error.status !== 401) setAuthUnavailable(true); }).finally(() => setAuthLoading(false));
  }, []);
  useEffect(() => {
    if (!user) return undefined;
    const refreshHandle = setTimeout(() => { void refresh(); }, 0);
    return () => clearTimeout(refreshHandle);
  }, [user, refresh]);
  const login = (nextUser, token) => { setUser(nextUser); setCsrfToken(token); setAuthUnavailable(false); };
  const logout = async () => {
    setLogoutError("");
    try { await api("/api/auth/logout", { method: "POST", headers: { "x-csrf-token": csrfToken } }); setUser(null); setCsrfToken(""); setPage("dashboard"); }
    catch (error) { setLogoutError(error.message || "Could not end the server session."); }
  };
  if (authLoading) return <div className="min-h-screen grid place-items-center bg-slate-900 text-slate-200">Checking server session…</div>;
  if (!user) return <><Auth onLogin={login}/>{authUnavailable && <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded bg-amber-950 p-3 text-sm text-amber-100">The authentication API is unavailable. Start the API and refresh.</div>}</>;
  const saveDomain = async (nextDomain) => { const data = await api("/api/domain", { method: "PUT", headers: { "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify({ expectedRevision: revision, domain: nextDomain }) }); setDomain(data.domain); setRevision(data.revision); await refresh(); };
  const generate = async () => { const data = await api("/api/timetables/generate", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrfToken }, body: "{}" }); await refresh(); return data; };
  const saveRules = async (nextRules) => { const data = await api("/api/constraints", { method: "PUT", headers: { "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify({ expectedRevision: revision, rules: nextRules }) }); setRules(data.rules); setRevision(data.revision); await refresh(); };
  return <div className="flex min-h-screen bg-slate-900 text-slate-100"><Sidebar user={user} onLogout={logout} setPage={setPage}/><main className="flex-1 p-6">
    {logoutError && <p role="alert" className="mb-4 rounded border border-rose-500/40 bg-rose-950/40 p-3 text-rose-200">{logoutError}</p>}
    {loadError && <p role="alert" className="mb-4 rounded border border-amber-500/40 bg-amber-950/40 p-3 text-amber-100">{loadError} <button className="underline" onClick={refresh}>Retry</button></p>}
    {page === "dashboard" && <Dashboard classrooms={domain.rooms} subjects={domain.subjects} teachers={domain.teachers} timetable={version?.timetable || ownSchedule}/>}
    {page === "admin" && user.role === "Admin" && <AdminPanel rooms={domain.rooms} subjects={domain.subjects} teachers={domain.teachers} batches={domain.batches} domain={domain} onSave={saveDomain} onGenerate={generate} generationResult={version} csrfToken={csrfToken} acceptedRules={rules}/>}
    {page === "copilot" && <CopilotPanel user={user} csrfToken={csrfToken} acceptedRules={rules} onSaveRules={saveRules}/>}
    {page === "hod" && user.role === "HOD" && <HODPanel versions={versions} timetable={version} csrfToken={csrfToken} onRefresh={refresh}/>}
    {page === "timetable" && <UserTimetablePanel role={user.role} timetable={ownSchedule}/>}
  </main></div>;
}
