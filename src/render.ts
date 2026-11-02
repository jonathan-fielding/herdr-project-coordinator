import { depMet, FINAL_STATES, taskNumber, type Task, type TaskState } from "./model.ts";
import type { ProjectMeta, TaskFile } from "./store.ts";

/** Sections in TASKS.md, most urgent first. */
const GROUPS: { title: string; states: TaskState[] }[] = [
  { title: "Needs you", states: ["needs_you"] },
  { title: "Working", states: ["starting", "working"] },
  { title: "Queued", states: ["queued"] },
  { title: "To do", states: ["todo"] },
  { title: "Failed", states: ["failed"] },
  { title: "Done, not merged", states: ["done"] },
  { title: "Merged", states: ["merged"] },
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
    .filter((d) => !depMet(all.get(d)))
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
    task.state === "needs_you" ? task.needsYouReason
    : task.state === "done" && task.mergeError ? `not merged: ${task.mergeError}`
    : task.summary;
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
  // One section per worktree, the main checkout first.
  const lanes = [...new Set(file.tasks.map((t) => t.lane))].sort((a, b) => (a === "root" ? -1 : b === "root" ? 1 : a.localeCompare(b)));
  for (const lane of lanes) {
    const branch = meta.lanes?.[lane]?.branch;
    out.push(`## Worktree ${lane}${branch && branch !== lane ? ` (${branch})` : ""}`, "");
    for (const g of GROUPS) {
      const ts = file.tasks.filter((t) => t.lane === lane && g.states.includes(t.state)).sort(byNumber);
      if (!ts.length) continue;
      out.push(`### ${g.title} (${ts.length})`, "", ...ts.map((t) => line(t, all)), "");
    }
  }
  return out.join("\n");
}
