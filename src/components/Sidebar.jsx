import React from "react";
export default function Sidebar({ user, onLogout, setPage }) {

  return (
    <aside className="w-64 bg-slate-800 border-r border-slate-700 p-4 flex flex-col">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-teal-400">Schedulify</h1>
        <p className="text-sm text-slate-400">
          {user.name} · {user.role}
        </p>
      </div>

      <nav className="space-y-2 flex-1">
        <NavBtn onClick={() => setPage("dashboard")}>Dashboard</NavBtn>

        {user.role === "Admin" && (
          <>
            <NavBtn onClick={() => setPage("admin")}>Admin</NavBtn>
            <NavBtn onClick={() => setPage("copilot")}>AI Copilot</NavBtn>
          </>
        )}

        {user.role === "HOD" && (
          <NavBtn onClick={() => setPage("hod")}>HOD</NavBtn>
        )}

        {(user.role === "Teacher" || user.role === "Student") && (
          <NavBtn onClick={() => setPage("timetable")}>Timetable</NavBtn>
        )}
      </nav>

      <button
        onClick={onLogout}
        className="bg-red-600 hover:bg-red-700 text-white py-2 rounded"
      >
        Logout
      </button>
    </aside>
  );
}

function NavBtn({ children, onClick }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left p-2 rounded bg-slate-700 hover:bg-slate-600 transition"
    >
      {children}
    </button>
  );
}
