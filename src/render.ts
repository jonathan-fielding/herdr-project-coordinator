import { FINAL_STATES, taskNumber, type Task, type TaskState } from "./model.ts";
import type { ProjectMeta, TaskFile } from "./store.ts";

/** Sections in TASKS.md, most urgent first. */
const GROUPS: { title: string; states: TaskState[] }[] = [
  { title: "Needs you", states: ["needs_you"] },
  { title: "Working", states: ["starting", "working"] },
  { title: "Queued", states: ["queued"] },
  { title: "To do", states: ["todo"] },
  { title: "Failed", states: ["failed"] },
  { title: "Done", states: ["done"] },
  { title: "Cancelled", states: ["cancelled"] },
];

export function byNumber(a: Task, b: Task): number {
  return taskNumber(a.id) - taskNumber(b.id);
}

/** One line; newlines and runs of spaces collapsed. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function pendingDeps(task: Task, all: Map<string, Task>): string[] {
  return task.dependsOn
    .filter((d) => all.get(d)?.state !== "done")
    .map((d) => `${d} (${all.get(d)?.state ?? "missing"})`);
}

function line(task: Task, all: Map<string, Task>): string {
  let s = `- **${task.id}** ${oneLine(task.title)}`;
  if (task.state === "starting") s += " _(starting)_";
  if (!FINAL_STATES.includes(task.state)) {
    const waits = pendingDeps(task, all);
    if (waits.length) s += ` · waits for ${waits.join(", ")}`;
  }
  const note =
    task.state === "needs_you" ? task.needsYouReason : task.summary;
  if (note) s += `\n  ${oneLine(note)}`;
  return s;
}

/** TASKS.md: tasks grouped by state, for people and the coordinator. Pure: same input, same output. */
export function renderTasksMd(meta: ProjectMeta, file: TaskFile): string {
  const all = new Map(file.tasks.map((t) => [t.id, t]));
  const out = [
    `# ${meta.name}: tasks`,
    "",
    "<!-- Written by hcoord from tasks.json. Edits here are overwritten; use hcoord. -->",
    "",
  ];
  if (file.tasks.length === 0) {
    out.push("_No tasks yet._", "");
    return out.join("\n");
  }
  for (const g of GROUPS) {
    const ts = file.tasks.filter((t) => g.states.includes(t.state)).sort(byNumber);
    if (!ts.length) continue;
    out.push(`## ${g.title} (${ts.length})`, "", ...ts.map((t) => line(t, all)), "");
  }
  return out.join("\n");
}
