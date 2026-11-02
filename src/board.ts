/** What the Herdr Projects section draws: every project's files, read-only, in one JSON document. */
import { claudeTrusts } from "./agents.ts";
import { loadConfig } from "./config.ts";
import type { Task, TaskState } from "./model.ts";
import { paths, root } from "./paths.ts";
import { byNumber } from "./render.ts";
import { listProjects, loadTasks } from "./store.ts";

export interface BoardTask {
  id: string;
  title: string;
  state: TaskState;
  /** needs_you: why. */
  reason?: string;
  /** done/failed: the report's first line. */
  summary?: string;
  /** The worker's hc address, while it has one. */
  terminal?: string;
  /** Dependencies not done yet. */
  waitingOn: string[];
  updatedAt: string;
}

export interface BoardProject {
  slug: string;
  name: string;
  prefix: string;
  repos: string[];
  dir: string;
  coordinator: { address: string; name: string } | null;
  /** Per repo: Claude trusts it (true), doesn't (false), can't tell (null). Empty for other agents. */
  trust: Record<string, boolean | null>;
  tasks: BoardTask[];
}

export interface Board {
  version: 1;
  root: string;
  worktreeRoot: string;
  agent: string;
  projects: BoardProject[];
}

function boardTask(t: Task, all: Map<string, Task>): BoardTask {
  const b: BoardTask = {
    id: t.id,
    title: t.title,
    state: t.state,
    waitingOn: t.dependsOn.filter((d) => all.get(d)?.state !== "done"),
    updatedAt: t.updatedAt,
  };
  if (t.needsYouReason) b.reason = t.needsYouReason;
  if (t.summary) b.summary = t.summary;
  if (t.terminal) b.terminal = t.terminal.address;
  return b;
}

/** Reads only: never syncs workers or writes anything. */
export function board(): Board {
  const config = loadConfig();
  const projects = listProjects().map((meta): BoardProject => {
    const tasks = loadTasks(meta.slug).tasks.sort(byNumber);
    const all = new Map(tasks.map((t) => [t.id, t]));
    const trust: Record<string, boolean | null> = {};
    if (config.agent.kind === "claude") for (const r of meta.repos) trust[r] = claudeTrusts(r);
    return {
      slug: meta.slug,
      name: meta.name,
      prefix: meta.prefix,
      repos: meta.repos,
      dir: paths.project(meta.slug),
      coordinator: meta.coordinator ?? null,
      trust,
      tasks: tasks.map((t) => boardTask(t, all)),
    };
  });
  return { version: 1, root: root(), worktreeRoot: config.worktreeRoot, agent: config.agent.kind, projects };
}
