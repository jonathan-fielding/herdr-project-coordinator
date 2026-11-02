/** What the Herdr Projects section draws: every project, its worktrees and tasks, read-only, in one JSON document. */
import { existsSync } from "node:fs";
import { claudeTrusts } from "./agents.ts";
import { loadConfig } from "./config.ts";
import { listWorktrees } from "./git.ts";
import { depMet, ROOT_LANE, type Task, type TaskState } from "./model.ts";
import { paths, root } from "./paths.ts";
import { byNumber } from "./render.ts";
import { listProjects, loadTasks, type CoordinatorRef } from "./store.ts";

export interface BoardTask {
  id: string;
  title: string;
  state: TaskState;
  lane: string;
  /** needs_you: why. */
  reason?: string;
  /** done/failed/merged: the report's first line. */
  summary?: string;
  /** done but not merged: why. */
  mergeError?: string;
  /** The worker's hc address, while it has one. */
  terminal?: string;
  /** It has a Claude transcript to show. */
  hasLog: boolean;
  /** Dependencies not merged yet. */
  waitingOn: string[];
  updatedAt: string;
}

export interface BoardLane {
  key: string;
  path: string;
  /** The branch checked out there now (git), else the one it was registered with. */
  branch: string | null;
  /** It still exists on disk. */
  present: boolean;
  coordinator: CoordinatorRef | null;
}

export interface BoardProject {
  slug: string;
  name: string;
  prefix: string;
  repo: string;
  dir: string;
  /** Registered worktrees ("root" first). */
  lanes: BoardLane[];
  /** Every checkout of the repo (git worktree list), hcoord's worker checkouts left out:
   *  the section matches Herdr spaces against these. */
  checkouts: { path: string; branch: string | null }[];
  /** Claude trusts the repo (true), doesn't (false), can't tell (null); null for other agents too. */
  trusted: boolean | null;
  tasks: BoardTask[];
}

export interface Board {
  version: 2;
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
    lane: t.lane,
    hasLog: !!t.session,
    waitingOn: t.dependsOn.filter((d) => !depMet(all.get(d))),
    updatedAt: t.updatedAt,
  };
  if (t.needsYouReason) b.reason = t.needsYouReason;
  if (t.summary) b.summary = t.summary;
  if (t.mergeError) b.mergeError = t.mergeError;
  if (t.terminal) b.terminal = t.terminal.address;
  return b;
}

/** Reads only: never syncs workers or writes anything. */
export function board(): Board {
  const config = loadConfig();
  const projects = listProjects().map((meta): BoardProject => {
    const tasks = loadTasks(meta.slug).tasks.sort(byNumber);
    const all = new Map(tasks.map((t) => [t.id, t]));
    let checkouts: { path: string; branch: string | null }[] = [];
    try {
      checkouts = listWorktrees(meta.repo).filter((w) => !w.path.startsWith(config.worktreeRoot + "/"));
    } catch {
      // The repo is gone or unreadable: no checkouts to match.
    }
    const lanes = Object.entries(meta.lanes)
      .sort(([a], [b]) => (a === ROOT_LANE ? -1 : b === ROOT_LANE ? 1 : a.localeCompare(b)))
      .map(([key, l]): BoardLane => ({
        key,
        path: l.path,
        branch: checkouts.find((c) => c.path === l.path)?.branch ?? l.branch,
        present: existsSync(l.path),
        coordinator: l.coordinator ?? null,
      }));
    return {
      slug: meta.slug,
      name: meta.name,
      prefix: meta.prefix,
      repo: meta.repo,
      dir: paths.project(meta.slug),
      lanes,
      checkouts,
      trusted: config.agent.kind === "claude" ? claudeTrusts(meta.repo) : null,
      tasks: tasks.map((t) => boardTask(t, all)),
    };
  });
  return { version: 2, root: root(), worktreeRoot: config.worktreeRoot, agent: config.agent.kind, projects };
}
