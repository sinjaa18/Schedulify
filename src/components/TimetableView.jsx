import React from "react";
export default function TimetableView({ timetable }) {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  const slots = ["9-10", "10-11", "11-12", "2-3", "3-4"];

  const find = (d, s) => timetable.filter((t) => t.day === d && t.slot === s);

  return (
    <div className="overflow-x-auto rounded border border-slate-700">
      <table className="w-full bg-slate-800 text-slate-100">
        <thead>
          <tr>
            <th className="border border-slate-700 p-2">Time</th>
            {days.map((d) => (
              <th key={d} className="border border-slate-700 p-2">
                {d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {slots.map((s) => (
            <tr key={s}>
              <td className="border border-slate-700 p-2 font-semibold">
                {s}
              </td>
              {days.map((d) => {
                const classes = find(d, s);
                return (
                  <td
                    key={d}
                    className="border border-slate-700 p-2 h-20"
                  >
                    <div className="space-y-1">{classes.map((c) => <div key={c.id} className="rounded bg-blue-600/20 p-2 text-sm">
                      <div className="font-bold">{c.subject}</div>
                      <div>{c.teacher}</div>
                      <div className="text-xs text-slate-300">{c.batch || "Unassigned batch"} · {c.room || "Unknown room"}</div>
                    </div>)}</div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
