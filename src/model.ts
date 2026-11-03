import { HcoordError } from "./errors.ts";

export const TASK_STATES = [
  "todo",
  "queued",
  "starting",
  "working",
  "needs_you",
  "done",
  "merged",
  "failed",
  "cancelled",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export interface Task {
  /** "<PREFIX>-<n>", e.g. "QHQ-12". */
  id: string;
  title: string;
  /** Full instructions given to the worker. */
  brief: string;
  state: TaskState;
  /** Absolute path of the project's repo (its main checkout). */
  repo: string;
  /** The worktree it belongs to (a key of the project's lanes): its coordinator runs it and its
   *  branch is merged back there. */
  lane: string;
  /** "coord/<id>-<slug>". */
  branch: string;
  /** Absolute path once created. */
  worktree?: string;
  /** Commit the branch was created from. */
  base?: string;
  /** hc terminal of the worker: address (e.g. "t12") and name (e.g. "w-qhq-12"). */
  terminal?: { address: string; name: string };
  /** Address of the coordinator terminal this worker reports to (its hc parent). */
  parent?: string;
  dependsOn: string[];
  needsYouReason?: string;
  /** True when needs_you came from the core seeing the worker blocked, not from a report. */
  needsYouAuto?: boolean;
  /** Set from the worker's final report. */
  summary?: string;
  /** Claude session of its (latest) worker: the transcript `hcoord log` shows. */
  session?: string;
  /** done, but merging into its worktree's branch failed: why. */
  mergeError?: string;
  /** merged: the commit the merge made in the worktree. */
  mergeCommit?: string;
  /** failed because its worker terminal vanished (a reboot, a core restart, hc kill): `hcoord recover` retries it. */
  lostWorker?: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Allowed moves. `starting -> done` covers a worker that reports before hcoord marks it working.
 * `failed`/`cancelled -> todo` is an explicit reopen; nothing reruns a task on its own.
 */
export const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  todo: ["queued", "starting", "cancelled"],
  queued: ["starting", "todo", "cancelled"],
  starting: ["working", "needs_you", "done", "failed", "cancelled"],
  working: ["needs_you", "done", "failed", "cancelled"],
  needs_you: ["working", "done", "failed", "cancelled"],
  done: ["merged"],
  merged: [],
  failed: ["todo"],
  cancelled: ["todo"],
};

/** States that need no further action from a worker. (done still waits for its merge.) */
export const FINAL_STATES: readonly TaskState[] = ["done", "merged", "failed", "cancelled"];

/** A dependency is met once its work is in the worktree's branch. */
export const depMet = (t: Task | undefined): boolean => t?.state === "merged";

export function isTaskState(s: string): s is TaskState {
  return (TASK_STATES as readonly string[]).includes(s);
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface StateChange {
  type: "task.state";
  task: string;
  from: TaskState;
  to: TaskState;
  data?: Record<string, unknown>;
}

/** Moves a task to `to`, or throws if that move isn't allowed. Returns the event to log. */
export function transition(
  task: Task,
  to: TaskState,
  now: string,
  data?: Record<string, unknown>,
): StateChange {
  const from = task.state;
  if (!canTransition(from, to)) {
    const allowed = TRANSITIONS[from];
    throw new HcoordError(
      `${task.id} is ${from}; it can't become ${to}` +
        (allowed.length ? ` (allowed: ${allowed.join(", ")})` : " (it's final)"),
    );
  }
  task.state = to;
  task.updatedAt = now;
  if (to !== "needs_you") {
    delete task.needsYouReason;
    delete task.needsYouAuto;
  }
  if (to !== "failed") delete task.lostWorker;
  if (to !== "done") delete task.mergeError;
  return { type: "task.state", task: task.id, from, to, ...(data ? { data } : {}) };
}

/** Lowercase, words joined by "-", at most `max` chars. */
export function slugify(text: string, max = 40): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // drop accents split off by NFKD
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, max)
    .replace(/^-+|-+$/g, "");
}

export function taskNumber(id: string): number {
  return Number(id.slice(id.lastIndexOf("-") + 1));
}

/** States that hold a worker slot. */
export const ACTIVE_STATES: readonly TaskState[] = ["starting", "working", "needs_you"];

/** hc terminal name for a task's worker: lowercase, hc allows [a-z0-9_-]{1,32}. */
export function workerName(id: string): string {
  return `w-${id.toLowerCase()}`.slice(0, 32);
}

/** A worker's branch: "coord/<lane>/<id>-<title slug>". */
export function branchFor(id: string, title: string, lane: string): string {
  const s = slugify(title, 40);
  return `coord/${lane}/${id.toLowerCase()}${s ? `-${s}` : ""}`;
}

/**
 * Whether a branch is an hcoord worker's ("coord/<lane>/<id>-…"), from this data folder or any
 * other (an old or test one): its checkout is never a worktree to coordinate.
 */
export function isWorkerBranch(branch: string | null | undefined): boolean {
  return !!branch && /^coord\/[^/]+\/[a-z][a-z0-9]{1,7}-\d+(-|$)/.test(branch);
}

/** The main checkout's lane key. Other worktrees are keyed by their branch's slug. */
export const ROOT_LANE = "root";
export const LANE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Prefix for a project's task ids: initials of a multi-word name, else its first 3 letters. */
export function defaultPrefix(name: string): string {
  const words = name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  const raw = words.length >= 2 ? words.map((w) => w[0]).join("").slice(0, 4) : (words[0] ?? "").slice(0, 3);
  return /^[A-Z]/.test(raw) ? raw : `P${raw}`.slice(0, 4);
}

export const PREFIX_RE = /^[A-Z][A-Z0-9]{1,7}$/;
