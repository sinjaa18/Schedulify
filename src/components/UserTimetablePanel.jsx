import TimetableView from "./TimetableView";

export default function UserTimetablePanel({ role, timetable = [] }) {
  return <div className="space-y-4"><h2 className="text-2xl font-bold">My {role} Timetable</h2>
    {!timetable.length ? <p className="text-slate-400">No published classes are assigned to your account.</p> : <TimetableView timetable={timetable}/>}
  </div>;
}
