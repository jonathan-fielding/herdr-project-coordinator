/**
 * Removing a worktree (`hcoord lane remove`) and deleting a project (`hcoord project delete`).
 * Both have a dry run (`--dry-run --json`) that says what would go and what's at risk, so the
 * Herdr section can ask first. Branches are never deleted by either.
 *
 * A project with a cleanup prompt removes a worktree in two steps: `lane remove` adds a cleanup task
 * for the worktree's coordinator to start, and the task's merge (workers.ts) calls finishRemoval.
 */
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { HcoordError } from "./errors.ts";
import { listWorktrees } from "./git.ts";
import { hcGet, hcKill } from "./hc.ts";
import { abandonCleanup, ACTIVE_STATES, FINAL_STATES, transition, type Task } from "./model.ts";
import { paths, root } from "./paths.ts";
import { loadSettings } from "./settings.ts";
import {
  beginRemoval,
  checkoutOf,
  clearRemoval,
  loadProject,
  loadTasks,
  mutate,
  projectForRepo,
  updateMeta,
  type CoordinatorRef,
  type PendingRemoval,
  type ProjectMeta,
} from "./store.ts";
import type { Outcome } from "./workers.ts";

function git(cwd: string, args: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  return { code: r.exitCode ?? 1, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

/** Uncommitted or untracked files in a checkout ([] when clean or unreadable). */
function changedFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  const r = git(path, ["--no-optional-locks", "status", "--porcelain"]);
  return r.code === 0 && r.out ? r.out.split("\n").map((l) => l.slice(3)) : [];
}

/** Commits on local branches that no remote has (all of them when the repo has no remote). */
function unpushedCommits(repo: string): number {
  const r = git(repo, ["rev-list", "--count", "--branches", "--not", "--remotes"]);
  return r.code === 0 ? Number(r.out) || 0 : 0;
}

/** Stops a terminal if it is still the one we started (same name). */
export function stop(t: { address: string; name: string } | undefined): string | null {
  if (!t) return null;
  const h = hcGet(t.address);
  if (!h || h.name !== t.name || h.state !== "live") return null;
  const k = hcKill(t.address);
  return k.ok ? `stopped ${t.name} (${t.address})` : `warning: couldn't stop ${t.address}: ${k.error}`;
}

/**
 * Cancels every unfinished task of the given worktrees (all when lanes is null), stopping their
 * workers. `keepCleanup`: not the cleanup tasks, which is what a delete waiting for one wants.
 */
async function cancelUnfinished(meta: ProjectMeta, lanes: Set<string> | null, why: string, keepCleanup = false): Promise<string[]> {
  const lines: string[] = [];
  const open = (t: Task) => !FINAL_STATES.includes(t.state) && (!lanes || lanes.has(t.lane)) && !(keepCleanup && t.cleanup);
  for (const t of loadTasks(meta.slug).tasks.filter(open)) {
    const s = stop(t.terminal);
    if (s) lines.push(s);
  }
  const ids = await mutate(meta.slug, ({ file, now }) => {
    const hit = file.tasks.filter(open);
    const events = hit.map((t) => transition(t, "cancelled", now, { why }));
    return { result: hit.map((t) => t.id), events };
  });
  if (ids.length) lines.push(`cancelled ${ids.join(", ")}`);
  return lines;
}

// ---------------------------------------------------------------- a worktree

export interface WorktreePlan {
  project: string;
  name: string;
  path: string;
  branch: string | null;
  lane: string | null;
  /** Uncommitted or untracked files there (lost when it's removed). */
  changed: string[];
  /** Tasks of this worktree that aren't finished: cancelled, their workers stopped. */
  unfinished: string[];
  /** Its coordinator, if running. */
  coordinator: string | null;
  /** Worker checkouts of its tasks: kept (`hcoord task clean` removes them). */
  workerCheckouts: string[];
  /** The project's cleanup prompt, run by a worker before the worktree is removed; null when none. */
  cleanupPrompt: string | null;
  /** The removal already waiting for its cleanup task, if any. */
  removing: PendingRemoval | null;
}

function worktreePlan(path: string): { meta: ProjectMeta; plan: WorktreePlan } {
  const co = checkoutOf(path);
  const meta = projectForRepo(co.main);
  if (!meta) throw new HcoordError(`${co.main} isn't a project`);
  if (co.top === meta.repo) throw new HcoordError(`${co.top} is ${meta.name}'s main checkout; it can't be removed as a worktree (delete the project instead)`);
  if (co.top.startsWith(loadConfig().worktreeRoot + "/")) throw new HcoordError(`${co.top} is a worker's checkout (hcoord task clean removes those)`);
  const lane = Object.entries(meta.lanes).find(([, l]) => l.path === co.top)?.[0] ?? null;
  const tasks = lane ? loadTasks(meta.slug).tasks.filter((t) => t.lane === lane) : [];
  const c = lane ? meta.lanes[lane]!.coordinator : undefined;
  const h = c && hcGet(c.address);
  return {
    meta,
    plan: {
      project: meta.slug,
      name: meta.name,
      path: co.top,
      branch: co.branch,
      lane,
      changed: changedFiles(co.top),
      unfinished: tasks.filter((t) => !FINAL_STATES.includes(t.state)).map((t) => t.id),
      coordinator: h && h.name === c!.name && h.state === "live" ? c!.address : null,
      workerCheckouts: tasks.filter((t) => t.worktree && existsSync(t.worktree)).map((t) => t.worktree!),
      cleanupPrompt: loadSettings(meta.slug).cleanupPrompt || null,
      removing: (lane && meta.lanes[lane]!.removing) || null,
    },
  };
}

export function planRemoveWorktree(path: string): WorktreePlan {
  return worktreePlan(path).plan;
}

/** `git worktree remove` (forced only with `force`, which loses uncommitted changes), then forgets it. */
async function dropWorktree(meta: ProjectMeta, plan: WorktreePlan, force: boolean): Promise<string[]> {
  const r = git(meta.repo, ["worktree", "remove", ...(force ? ["--force"] : []), plan.path]);
  if (r.code !== 0) throw new HcoordError(`git worktree remove ${plan.path}: ${r.err || r.out}`);
  const lines = [`removed worktree ${plan.path}${plan.branch ? `; branch ${plan.branch} kept` : ""}`];
  if (plan.lane) {
    await updateMeta(meta.slug, (m) => {
      delete m.lanes[plan.lane!];
      return { result: null, event: { type: "lane.removed", data: { lane: plan.lane, path: plan.path, branch: plan.branch } } };
    });
  }
  if (plan.workerCheckouts.length) lines.push(`its tasks' checkouts are kept (hcoord task clean ID): ${plan.workerCheckouts.join(", ")}`);
  return lines;
}

/** Drops a worktree's pending removal, giving up on its cleanup task. cancelUnfinished can't end a failed or done one. */
async function callOffRemoval(meta: ProjectMeta, lane: string, removing: PendingRemoval, why: string): Promise<string[]> {
  const cancelled = await mutate(meta.slug, ({ file, now }) => {
    const t = file.tasks.find((x) => x.id === removing.task);
    const ev = t ? abandonCleanup(t, now, { why }) : null;
    return { result: !!ev, events: ev ? [ev] : [] };
  });
  await clearRemoval(meta.slug, lane, removing.task);
  return cancelled ? [`cancelled ${removing.task}`] : [];
}

/** What the worktree's coordinator is told to do about its cleanup task, by the state that's in. */
function cleanupNote(t: Task): string | null {
  const then = "then end your turn. hcoord removes the worktree once that task is merged.";
  const say = (cmd: string) => `Cleanup before deleting this worktree: run \`hcoord task ${cmd} ${t.id}\`, ${then}`;
  if (t.state === "todo" || t.state === "queued") return say("start");
  if (t.state === "failed") return say("retry");
  if (t.state === "done") return say("merge");
  return null;
}

function cleanupBrief(prompt: string, plan: WorktreePlan, force: boolean): string {
  return `${prompt}

## The worktree being deleted

This task runs just before the worktree below is deleted. You run in a checkout of your own, not in
that worktree, so reach it by its path. For this worktree, this overrides the rule to work only
inside your own.

- Path: ${plan.path}
- Branch: ${plan.branch ?? "(detached)"}

hcoord deletes the worktree and keeps its branch once this task is merged.
${force ? "Uncommitted changes there are discarded." : "Leave no uncommitted or untracked files there, or hcoord can't delete it."}
If the cleanup can't be done, report failed: the worktree is then kept.
`;
}

/** Puts a worktree's removal off until its cleanup task is merged. */
async function deferRemoval(meta: ProjectMeta, plan: WorktreePlan, opts: RemoveOptions): Promise<RemoveOutcome> {
  const force = !!opts.force;
  // Its coordinator runs the task, so it needs to be a worktree hcoord knows.
  const lane = plan.lane ?? (await opts.registerLane!(plan.path)).lane;
  const lines = await cancelUnfinished(meta, new Set([lane]), "worktree removed", true);
  const task = await beginRemoval(meta.slug, lane, { title: `Clean up before removing ${lane}`, brief: cleanupBrief(plan.cleanupPrompt!, plan, force) }, force);
  // Merged already: only the removal itself failed last time.
  if (task.state === "merged") {
    const f = await finishRemoval(meta.slug, task.id);
    if (!f) throw new HcoordError(`${task.id}'s removal disappeared`);
    const s = stop(f.coordinator);
    return { ok: f.ok, lines: [...lines, ...f.lines, ...(s ? [s] : [])] };
  }
  const running = ACTIVE_STATES.includes(task.state);
  lines.push(`${plan.path} is removed once ${task.id} is merged${running ? ` (it's ${task.state})` : ""}`);
  return { ok: true, lines, cleanup: task.id, tell: cleanupNote(task) ?? undefined };
}

export interface RemoveOptions {
  force?: boolean;
  /** Remove it now, cleanup prompt or not, calling off any pending removal. */
  skipCleanup?: boolean;
  /** Registers a worktree as a lane (coordinator.ts): needed when it has to run a cleanup task. */
  registerLane?: (path: string) => Promise<{ lane: string }>;
}

export interface RemoveOutcome extends Outcome {
  /** The removal waits for this cleanup task. */
  cleanup?: string;
  /** What to tell the worktree's coordinator about that task, if anything. */
  tell?: string;
}

/**
 * Removes a linked worktree: cancels its unfinished tasks, stops its coordinator, runs
 * `git worktree remove` and forgets it. Its branch is kept, and so are its tasks' checkouts and
 * history. With a cleanup prompt (and no skipCleanup) it only cancels the tasks and defers the rest.
 */
export async function removeWorktreeLane(path: string, opts: RemoveOptions = {}): Promise<RemoveOutcome> {
  const { meta, plan } = worktreePlan(path);
  if (plan.changed.length && !opts.force) {
    throw new HcoordError(`${plan.path} has uncommitted changes (${plan.changed.slice(0, 5).join(", ")}${plan.changed.length > 5 ? ", …" : ""}); --force removes it anyway`);
  }
  if (plan.cleanupPrompt && !opts.skipCleanup) return deferRemoval(meta, plan, opts);
  const lines: string[] = [];
  if (plan.lane) {
    lines.push(...(await cancelUnfinished(meta, new Set([plan.lane]), "worktree removed")));
    if (plan.removing) lines.push(...(await callOffRemoval(meta, plan.lane, plan.removing, "cleanup skipped")));
    const s = stop(meta.lanes[plan.lane]!.coordinator);
    if (s) lines.push(s);
  }
  lines.push(...(await dropWorktree(meta, plan, !!opts.force)));
  return { ok: true, lines };
}

export interface RemovalFinish extends Outcome {
  /** To stop once the caller has nothing left to do: see finishRemoval. */
  coordinator?: CoordinatorRef;
}

/**
 * The cleanup task `id` is merged: removes the worktree waiting for it, with the force saved then.
 * Null when none is. If git refuses, the worktree and its pending removal stay and ok is false.
 *
 * The coordinator is left for the caller to stop, last: it has to be there to hear of a failure, and
 * stopping it hangs up on its terminal, which is where `hcoord task merge` itself may be running.
 */
export async function finishRemoval(project: string, id: string): Promise<RemovalFinish | null> {
  const meta = loadProject(project);
  const entry = Object.entries(meta.lanes).find(([, l]) => l.removing?.task === id);
  if (!entry) return null;
  const [lane, { path, removing, coordinator }] = entry;
  const lines = await cancelUnfinished(meta, new Set([lane]), "worktree removed");
  try {
    lines.push(...(await dropWorktree(meta, worktreePlan(path).plan, removing!.force)));
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { ok: false, lines: [...lines, `the worktree wasn't removed: ${why}`] };
  }
  return { ok: true, lines, coordinator };
}

// ---------------------------------------------------------------- a project

export interface ProjectPlan {
  project: string;
  name: string;
  repo: string;
  /** Every checkout of the repo except workers': the main one first. */
  checkouts: { path: string; branch: string | null; changed: number }[];
  /** hcoord's worker checkouts for this project (one folder). */
  workerDir: string | null;
  workerCheckouts: { path: string; changed: number }[];
  /** Commits on local branches no remote has: gone with the files. */
  unpushed: number;
  unfinished: string[];
  coordinators: string[];
  /** Where its tasks, reports and notes are moved to. */
  archive: string;
  /** Where deleted files go: the Trash, or nowhere (deleted outright). */
  trash: boolean;
}

const TRASH = "/usr/bin/trash";

function projectPlan(slug: string): { meta: ProjectMeta; plan: ProjectPlan } {
  const meta = loadProject(slug);
  const wtRoot = loadConfig().worktreeRoot;
  let all: { path: string; branch: string | null }[] = [];
  try {
    all = listWorktrees(meta.repo);
  } catch {
    // The repo is gone: nothing of it to list.
  }
  const workerDir = join(wtRoot, meta.slug);
  const mine = all.filter((w) => w.path.startsWith(wtRoot + "/"));
  const checkouts = all
    .filter((w) => !w.path.startsWith(wtRoot + "/"))
    .sort((a, b) => (a.path === meta.repo ? -1 : b.path === meta.repo ? 1 : a.path.localeCompare(b.path)))
    .map((w) => ({ ...w, changed: changedFiles(w.path).length }));
  const coordinators = Object.values(meta.lanes)
    .map((l) => l.coordinator)
    .filter((c): c is NonNullable<typeof c> => {
      const h = c && hcGet(c.address);
      return !!h && h.name === c!.name && h.state === "live";
    })
    .map((c) => c.address);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return {
    meta,
    plan: {
      project: meta.slug,
      name: meta.name,
      repo: meta.repo,
      checkouts,
      workerDir: existsSync(workerDir) ? workerDir : null,
      workerCheckouts: mine.map((w) => ({ path: w.path, changed: changedFiles(w.path).length })),
      unpushed: existsSync(meta.repo) ? unpushedCommits(meta.repo) : 0,
      unfinished: loadTasks(meta.slug).tasks.filter((t) => !FINAL_STATES.includes(t.state)).map((t) => t.id),
      coordinators,
      archive: join(root(), "deleted", `${meta.slug}-${stamp}`),
      trash: existsSync(TRASH) && !process.env.HCOORD_NO_TRASH,
    },
  };
}

export function planDeleteProject(slug: string): ProjectPlan {
  return projectPlan(slug).plan;
}

/** Folders we refuse to delete whatever the project says. */
function unsafe(path: string): boolean {
  const p = path.replace(/\/+$/, "");
  const home = homedir();
  return !p || p === "/" || p === home || !p.startsWith("/") || p.split("/").length < 3 || home.startsWith(p + "/") || p === root() || root().startsWith(p + "/");
}

function removeFolder(path: string, trash: boolean): string {
  if (!existsSync(path)) return `${path} was already gone`;
  if (unsafe(path)) throw new HcoordError(`refusing to delete ${path}`);
  if (trash) {
    const r = Bun.spawnSync([TRASH, path], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    if (r.exitCode !== 0) throw new HcoordError(`moving ${path} to the Trash: ${r.stderr.toString().trim() || `exit ${r.exitCode}`}`);
    return `moved ${path} to the Trash`;
  }
  rmSync(path, { recursive: true, force: true });
  return `deleted ${path}`;
}

/**
 * Deletes a project from hcoord: stops its coordinators and workers, cancels unfinished tasks and
 * moves its hcoord folder (tasks, reports, notes) to <root>/deleted/. Worker checkouts that git says
 * are clean are removed (their branches kept); others are kept and listed.
 * With `files`, the repo, its other worktrees and every worker checkout go too: to the Trash when
 * macOS has `trash`, else deleted outright.
 */
export async function deleteProject(slug: string, opts: { files?: boolean } = {}): Promise<Outcome> {
  const { meta, plan } = projectPlan(slug);
  if (opts.files) for (const c of plan.checkouts) if (unsafe(c.path)) throw new HcoordError(`refusing to delete ${c.path}`);
  const lines: string[] = [];
  lines.push(...(await cancelUnfinished(meta, null, "project deleted")));
  for (const l of Object.values(meta.lanes)) {
    const s = stop(l.coordinator);
    if (s) lines.push(s);
  }

  if (opts.files) {
    // Worktrees before the repo that holds their git data.
    if (plan.workerDir) lines.push(removeFolder(plan.workerDir, plan.trash));
    for (const c of plan.checkouts.slice().reverse()) {
      if (c.path === meta.repo || plan.checkouts.some((o) => o.path !== c.path && c.path.startsWith(o.path + "/"))) continue;
      lines.push(removeFolder(c.path, plan.trash));
    }
    lines.push(removeFolder(meta.repo, plan.trash));
  } else {
    for (const w of plan.workerCheckouts) {
      if (w.changed) {
        lines.push(`kept ${w.path} (uncommitted changes)`);
        continue;
      }
      const r = git(meta.repo, ["worktree", "remove", w.path]);
      lines.push(r.code === 0 ? `removed worker checkout ${w.path}` : `kept ${w.path}: ${r.err || r.out}`);
    }
    lines.push(`left ${meta.repo}${plan.checkouts.length > 1 ? ` and its ${plan.checkouts.length - 1} other worktree(s)` : ""} as they are; branches kept`);
  }

  mkdirSync(join(root(), "deleted"), { recursive: true });
  renameSync(paths.project(meta.slug), plan.archive);
  lines.push(`moved ${meta.name}'s tasks, reports and notes to ${plan.archive}`);
  return { ok: true, lines };
}

