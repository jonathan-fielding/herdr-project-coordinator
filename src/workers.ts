import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeTrusts, showsTrustPrompt, untrustedRepoMessage, workerArgv } from "./agents.ts";
import { renderWorkerBrief } from "./brief.ts";
import { loadConfig } from "./config.ts";
import { HcoordError, UsageError } from "./errors.ts";
import { commitsSince, dirtyFiles, ensureWorktree, mergeBranch, mergedInto, removeWorktree } from "./git.ts";
import { withLock } from "./fsutil.ts";
import { hcCall, hcGet, hcKill, hcList, hcRm, hcRunBg, hcSend, type HcTerminal } from "./hc.ts";
import { abandonCleanup, ACTIVE_STATES, depMet, FINAL_STATES, transition, workerName, type Task, type TaskState } from "./model.ts";
import { paths } from "./paths.ts";
import { finishRemoval, stop } from "./remove.ts";
import { byNumber } from "./render.ts";
import { clearRemoval, findTask, loadProject, loadTasks, mutate, type CoordinatorRef, type Lane, type NewEvent, type ProjectMeta } from "./store.ts";

/** What a command did, line by line, and whether all of it worked. */
export interface Outcome {
  lines: string[];
  ok: boolean;
}

function get(file: { tasks: Task[] }, id: string): Task {
  const t = file.tasks.find((x) => x.id === id);
  if (!t) throw new HcoordError(`task ${id} disappeared from tasks.json`);
  return t;
}

/** Dependencies not merged yet, as "ID (state)". */
function pendingDeps(task: Task, tasks: Task[]): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return task.dependsOn
    .filter((d) => !depMet(byId.get(d)))
    .map((d) => `${d} (${byId.get(d)?.state ?? "missing"})`);
}

/** Workers running in one worktree: maxParallel applies to each worktree. */
const activeCount = (tasks: Task[], lane: string) =>
  tasks.filter((t) => t.lane === lane && ACTIVE_STATES.includes(t.state)).length;

export function laneOf(meta: ProjectMeta, key: string): Lane {
  const lane = meta.lanes[key];
  if (!lane) throw new HcoordError(`${meta.slug} has no worktree "${key}" (it has: ${Object.keys(meta.lanes).join(", ")})`);
  return lane;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** First meaningful line of a report, without markdown markers, ≤ 200 chars. */
export function summaryOf(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.replace(/^\s*(#+|[-*>]|\d+\.)\s*/, "").trim())
    .find(Boolean);
  const s = line ?? "";
  return s.length > 200 ? s.slice(0, 199) + "…" : s;
}

/** The task's worker terminal, only if the core still has that exact terminal (addresses can be reused). */
function ourTerminal(task: Task): HcTerminal | null {
  if (!task.terminal) return null;
  const h = hcGet(task.terminal.address);
  if (!h) return null;
  if (h.name !== task.terminal.name) return null;
  if (h.labels && h.labels["hcoord.task"] !== task.id) return null;
  return h;
}

// ---------------------------------------------------------------- who gets notes

/**
 * What became of a worktree's coordinator:
 * - running: our agent.
 * - prompt: our program, reporting no status (Claude's trust question, or still starting).
 * - shell: replaced by a shell with nothing running in it, or about to be. Safe to replace.
 * - occupied: replaced, and something else runs in that shell. Never ours to stop.
 * - none: no such terminal running.
 */
export type CoordinatorState = "running" | "prompt" | "shell" | "occupied" | "none";

/**
 * Sorts a coordinator's terminal (`hc get`) into a CoordinatorState. The test is what the terminal
 * runs, not which shell: everything hcoord starts for a project goes through `env HCOORD_PROJECT=<slug>`
 * (agents.ts), and only a kept terminal can lose that, its argv then being the shell's. The marker is
 * in the terminal itself, so it needs no record and holds for coordinators started by older versions.
 * Status can't tell: a Claude started by hand in the shell reports one too.
 */
export function classifyCoordinator(t: HcTerminal | null, slug: string, claude: boolean): CoordinatorState {
  if (!t || t.state !== "live") return "none";
  // Its program is lost and the core hasn't started the shell yet (reason: stopped_by_restart, signaled).
  if (t.pid === null) return "shell";
  // Not kept, or no argv (a core too old to say): all we have is the status.
  const replaced = t.keep && t.argv && !(t.argv[0] === "env" && t.argv.includes(`HCOORD_PROJECT=${slug}`));
  if (!replaced) return claude && !t.status ? "prompt" : "running";
  // Foreground unknown counts as occupied: a shell shows none for a moment as it starts, and looking
  // again is cheap, where stopping what someone runs isn't.
  const fg = t.foreground;
  return fg && fg.pid === t.pid && fg.argv.join("\0") === t.argv!.join("\0") ? "shell" : "occupied";
}

/** The terminal recorded as a worktree's coordinator, if the core still has that exact live terminal. */
export function recordedCoordinator(meta: ProjectMeta, lane: string): HcTerminal | null {
  const c = meta.lanes[lane]?.coordinator;
  const h = c ? hcGet(c.address) : null;
  return h && h.state === "live" && h.name === c!.name ? h : null;
}

/**
 * The program in a terminal's foreground, by the name it was run as: "claude", "vim", or null when the
 * core doesn't say. `foreground.name` won't do: it's the process's own name, Claude's version here.
 * Status only decides when argv can't (npm's node, or Claude run by its versioned path): any other
 * program may just have a status left over from what ran there before. `hc get` gives status as
 * `{ app, state }`, which HcTerminal doesn't describe.
 */
export function foregroundProgram(t: HcTerminal | null): string | null {
  const cmd = t?.foreground?.argv[0];
  if (!cmd) return null;
  const name = cmd.split("/").pop() || cmd;
  if (name === "claude") return name;
  const reports = (t!.status as unknown as { app?: string } | null | undefined)?.app;
  return reports === "claude-code" && /^(node|bun|\d+(\.\d+)+)$/.test(name) ? "claude" : name;
}

/** A coordinator's state and, when occupied, what occupies it, from one look at its terminal. */
export function coordinatorNow(meta: ProjectMeta, lane: string): { state: CoordinatorState; program: string | null } {
  const t = recordedCoordinator(meta, lane);
  const state = classifyCoordinator(t, meta.slug, loadConfig().agent.kind === "claude");
  return { state, program: state === "occupied" ? foregroundProgram(t) : null };
}

export function coordinatorState(meta: ProjectMeta, lane: string): CoordinatorState {
  return coordinatorNow(meta, lane).state;
}

/** A worktree's coordinator, if its terminal is still that exact live terminal and still runs our agent. */
export function liveCoordinator(meta: ProjectMeta, lane: string): CoordinatorRef | null {
  const state = coordinatorState(meta, lane);
  return state === "running" || state === "prompt" ? meta.lanes[lane]!.coordinator! : null;
}

/**
 * Whether this address is a worktree's recorded coordinator that doesn't run our agent any more.
 * What's there now is a plain shell or someone's own program, so typing a note there can run it as a
 * command or hand it to an agent it isn't for.
 */
function formerCoordinator(meta: ProjectMeta, lane: string, address: string): boolean {
  return address === meta.lanes[lane]?.coordinator?.address && !liveCoordinator(meta, lane);
}

/**
 * Where a task's news goes: its worktree's live coordinator (it may have been restarted), else the
 * worker's parent, unless that parent is the coordinator we've just found isn't live. Null then:
 * the state is saved, and the coordinator sees it in `hcoord task list` when it comes back.
 */
function notifyTarget(meta: ProjectMeta, task: Task): string | null {
  const live = liveCoordinator(meta, task.lane);
  if (live) return live.address;
  return task.parent && !formerCoordinator(meta, task.lane, task.parent) ? task.parent : null;
}

/**
 * The coordinator terminal a new worker reports to (its hc parent): an explicit --parent, else the
 * project's coordinator, else `fallback` (the reporting worker's coordinator), else the caller when
 * the caller isn't one of our workers. Never a worker or a former coordinator: that would send
 * notes to the wrong place.
 */
export function resolveParent(meta: ProjectMeta, lane: string, explicit?: string, fallback?: string): string | null {
  if (explicit) {
    const h = hcGet(explicit);
    if (!h || h.state !== "live") throw new HcoordError(`--parent ${explicit} isn't a live terminal`);
    return h.address;
  }
  for (const c of [meta.lanes[lane]?.coordinator?.address, fallback, process.env.HC_TERMINAL_ID]) {
    if (!c) continue;
    const h = hcGet(c);
    if (h?.state === "live" && !h.labels?.["hcoord.task"] && !formerCoordinator(meta, lane, h.address)) return h.address;
  }
  return null;
}

// ---------------------------------------------------------------- launching

/** PROJECT.md without its generated header comment, for the worker brief. */
function readProjectNotes(slug: string): string {
  try {
    return readFileSync(paths.projectMd(slug), "utf8").replace(/<!--[\s\S]*?-->/g, "").trim();
  } catch {
    return "";
  }
}

/** Refuses to start a Claude worker in a repo Claude doesn't trust (it would hang at the dialog). */
function assertTrusted(repo: string): void {
  if (loadConfig().agent.kind === "claude" && claudeTrusts(repo) === false) {
    throw new HcoordError(untrustedRepoMessage(repo));
  }
}

/** Warnings for project repos Claude doesn't trust yet (shown by project new/open). */
export function trustWarnings(meta: ProjectMeta): string[] {
  if (loadConfig().agent.kind !== "claude") return [];
  return claudeTrusts(meta.repo) === false ? [`warning: ${untrustedRepoMessage(meta.repo)}`] : [];
}

const FIRST_STATUS_MS = 20_000;

/**
 * Right after a Claude worker starts: wait (briefly) for its first status report. If it hasn't
 * reported and its screen shows the trust dialog, say so, instead of letting it wait silently.
 */
async function checkFirstStatus(address: string): Promise<string | null> {
  const end = Date.now() + FIRST_STATUS_MS;
  while (Date.now() < end) {
    const h = hcGet(address);
    if (!h || h.state !== "live" || h.status) return null;
    const screen = hcCall(["read", address]);
    if (screen.ok && showsTrustPrompt(JSON.stringify(screen.data))) {
      return `worker is stuck at Claude's "trust this folder?" prompt; trust the repo (or answer it: hc attach ${address})`;
    }
    await Bun.sleep(500);
  }
  return null;
}

/** Creates the worktree and starts the worker for a task already claimed as `starting`. */
async function launch(slug: string, id: string, parent: string | null): Promise<Outcome> {
  const meta = loadProject(slug);
  const config = loadConfig();
  const task = get(loadTasks(slug), id);
  const wt = join(config.worktreeRoot, slug, id.toLowerCase());
  try {
    assertTrusted(task.repo);
    const lane = laneOf(meta, task.lane);
    if (!existsSync(lane.path)) throw new HcoordError(`its worktree ${lane.path} is gone`);
    mkdirSync(dirname(wt), { recursive: true });
    // The worker's branch starts where its worktree is now.
    const made = ensureWorktree(task.repo, wt, task.branch, lane.path);
    // A retried task keeps the base its branch was made from.
    const base = task.base ?? made.base;
    const worktree = realpathSync(wt);
    const resume = made.reused ? { commits: commitsSince(worktree, base), dirty: dirtyFiles(worktree) } : undefined;
    const prompt = renderWorkerBrief({ meta, task, worktree, coordinator: parent, projectNotes: readProjectNotes(slug), resume });
    const session = config.agent.kind === "claude" ? crypto.randomUUID() : undefined;
    const term = hcRunBg({
      name: workerName(id),
      cwd: worktree,
      argv: workerArgv(config, slug, id, workerName(id), prompt, session),
      parent,
      labels: { "hcoord.project": slug, "hcoord.task": id },
    });
    const stillStarting = await mutate(slug, ({ file, now }) => {
      const t = get(file, id);
      Object.assign(t, { worktree, base, terminal: term, updatedAt: now });
      if (session) t.session = session;
      if (parent) t.parent = parent;
      else delete t.parent;
      if (t.state !== "starting") {
        return { result: false, events: [{ type: "task.updated", task: id, data: { note: "cancelled while starting", terminal: term.address } }] };
      }
      const ev = transition(t, "working", now, { terminal: term.address, name: term.name, worktree, parent });
      return { result: true, events: [ev] };
    });
    if (!stillStarting) {
      hcKill(term.address);
      return { ok: true, lines: [`${id} was cancelled while starting; stopped ${term.name} (${term.address})`] };
    }
    const lines = [`started ${id}: ${term.name} (${term.address}) in ${worktree}${parent ? `, reporting to ${parent}` : ", no coordinator"}`];
    if (config.agent.kind === "claude") {
      const stuck = await checkFirstStatus(term.address);
      if (stuck) {
        const changed = await mutate(slug, ({ file, now }) => {
          const t = get(file, id);
          if (t.state !== "working") return { result: false, events: [] };
          const ev = transition(t, "needs_you", now, { by: "launch-check", reason: stuck });
          t.needsYouReason = stuck;
          t.needsYouAuto = true;
          return { result: true, events: [ev] };
        });
        if (changed) {
          lines.push(`${id} → needs_you: ${stuck}`);
          // Only tell the coordinator when someone else (a worker's report) started this task.
          const to = notifyTarget(meta, { ...task, parent: parent ?? undefined });
          if (to && to !== process.env.HC_TERMINAL_ID) hcSend(to, `${id} needs_you: ${stuck}`);
        }
      }
    }
    return { ok: true, lines };
  } catch (e) {
    const reason = errText(e);
    await mutate(slug, ({ file, now }) => {
      const t = get(file, id);
      if (t.state !== "starting") return { result: null, events: [] };
      if (existsSync(wt)) t.worktree = realpathSync(wt);
      const ev = transition(t, "failed", now, { reason });
      t.summary = `could not start: ${reason}`;
      return { result: null, events: [ev] };
    });
    return { ok: false, lines: [`${id} failed to start: ${reason}`] };
  }
}

/** Starts queued tasks whose dependencies are done, while worker slots are free. */
export async function schedule(slug: string, fallbackParent?: { lane: string; address: string }): Promise<Outcome> {
  if (!loadTasks(slug).tasks.some((t) => t.state === "queued")) return { ok: true, lines: [] };
  const max = loadConfig().maxParallel;
  const claimed = await mutate(slug, ({ file, now }) => {
    const running: Record<string, number> = {};
    const ids: string[] = [];
    const events: NewEvent[] = [];
    for (const t of file.tasks.filter((x) => x.state === "queued").sort(byNumber)) {
      running[t.lane] ??= activeCount(file.tasks, t.lane);
      if (running[t.lane]! >= max) continue;
      if (pendingDeps(t, file.tasks).length) continue;
      events.push(transition(t, "starting", now, { by: "scheduler" }));
      ids.push(t.id);
      running[t.lane]! += 1;
    }
    return { result: ids, events };
  });
  const out: Outcome = { ok: true, lines: [] };
  if (!claimed.length) return out;
  const meta = loadProject(slug);
  const tasks = loadTasks(slug).tasks;
  for (const id of claimed) {
    const lane = get({ tasks }, id).lane;
    const r = await launch(slug, id, resolveParent(meta, lane, undefined, fallbackParent?.lane === lane ? fallbackParent.address : undefined));
    out.lines.push(...r.lines);
    out.ok &&= r.ok;
  }
  return out;
}

export async function startTask(idArg: string, opts: { parent?: string } = {}): Promise<Outcome> {
  const { meta, task } = findTask(idArg);
  const slug = meta.slug;
  const id = task.id;
  const max = loadConfig().maxParallel;
  assertTrusted(task.repo);
  const parent = resolveParent(meta, task.lane, opts.parent);
  const decision = await mutate(slug, ({ file, now }) => {
    const t = get(file, id);
    if (ACTIVE_STATES.includes(t.state)) {
      throw new HcoordError(`${id} is already ${t.state}${t.terminal ? ` (${t.terminal.name}, ${t.terminal.address})` : ""}`);
    }
    if (t.state !== "todo" && t.state !== "queued") {
      throw new HcoordError(`${id} is ${t.state}; only todo or queued tasks can start`);
    }
    const waits = pendingDeps(t, file.tasks);
    const running = activeCount(file.tasks, t.lane);
    if (waits.length || running >= max) {
      const events = t.state === "todo" ? [transition(t, "queued", now, { waits, running, max })] : [];
      return { result: { start: false, waits, running }, events };
    }
    return { result: { start: true, waits, running }, events: [transition(t, "starting", now, { parent })] };
  });
  if (!decision.start) {
    const why = decision.waits.length
      ? `waits for ${decision.waits.join(", ")}`
      : `all ${max} worker slots are busy`;
    const lines = [`${id} queued: ${why}. It starts by itself when that changes.`];
    const stuck = decision.waits.filter((w) => /\((failed|cancelled|missing)\)$/.test(w));
    if (stuck.length) lines.push(`warning: ${stuck.join(", ")} won't finish as things stand, so ${id} will wait until it's reopened`);
    return { ok: true, lines };
  }
  return launch(slug, id, parent);
}

/**
 * Run by a Claude worker's Stop hook at the end of each turn. If the task is still "working", the
 * worker stopped without reporting (it asked in plain text, or gave up): mark it needs_you and tell
 * the coordinator, since the core sends no note for an ordinary end of turn. Otherwise do nothing.
 */
/** A failed or cancelled task back to todo, then started again in its worktree (work so far kept). */
export async function retryTask(idArg: string, opts: { parent?: string } = {}): Promise<Outcome> {
  const { meta, task } = findTask(idArg);
  assertTrusted(task.repo);
  await mutate(meta.slug, ({ file, now }) => {
    const t = get(file, task.id);
    if (t.state !== "failed" && t.state !== "cancelled") {
      throw new HcoordError(`${t.id} is ${t.state}; only failed or cancelled tasks can be retried`);
    }
    if (t.cleanup && loadProject(meta.slug).lanes[t.lane]?.removing?.task !== t.id) {
      throw new HcoordError(`${t.id} cleans up for a removal that was called off; delete the worktree again to run it`);
    }
    return { result: null, events: [transition(t, "todo", now, { by: "retry" })] };
  });
  // A worker that reported failed is still there, and would hold the new one's name.
  const old = ourTerminal(task);
  if (old?.state === "live") hcKill(old.address);
  return startTask(task.id, opts);
}

export async function workerStopped(idArg: string): Promise<Outcome> {
  const { meta, task } = findTask(idArg);
  if (task.state !== "working") return { ok: true, lines: [] };
  const caller = process.env.HC_TERMINAL_ID;
  if (caller && task.terminal && caller !== task.terminal.address) return { ok: true, lines: [] }; // not its worker
  const where = task.terminal ? `; hc read ${task.terminal.address}` : "";
  const reason = `worker ended its turn without reporting${where}`;
  const changed = await mutate(meta.slug, ({ file, now }) => {
    const t = get(file, task.id);
    if (t.state !== "working") return { result: false, events: [] };
    const ev = transition(t, "needs_you", now, { by: "stop-hook", reason });
    t.needsYouReason = reason;
    t.needsYouAuto = true;
    return { result: true, events: [ev] };
  });
  const parent = notifyTarget(meta, task);
  if (changed && parent) hcSend(parent, `${task.id} needs_you: ${reason}`);
  return { ok: true, lines: [] };
}

// ---------------------------------------------------------------- reports

export type ReportState = "done" | "needs_you" | "failed";
export const REPORT_STATES: readonly ReportState[] = ["done", "needs_you", "failed"];

export async function report(
  idArg: string,
  state: ReportState,
  text: string,
  opts: { notify?: boolean } = {},
): Promise<Outcome> {
  if (!REPORT_STATES.includes(state)) throw new UsageError(`--state must be one of ${REPORT_STATES.join(", ")}`);
  if (!text.trim()) throw new UsageError("the report is empty");
  const { meta, task } = findTask(idArg);
  const slug = meta.slug;
  const id = task.id;
  // Only commits are merged: uncommitted work would be left behind without anyone knowing.
  if (state === "done" && task.worktree && existsSync(task.worktree)) {
    let dirty = "";
    try {
      dirty = dirtyFiles(task.worktree);
    } catch {
      // Can't tell: let the merge speak for itself.
    }
    if (dirty) {
      throw new HcoordError(
        `${task.worktree} has uncommitted changes; commit them to ${task.branch} (or remove them), then report done again:\n${dirty}`,
      );
    }
  }
  const line = summaryOf(text);
  const reportPath = join(paths.reports(slug), `${id}.md`);

  const updated = await mutate(slug, ({ file, now }) => {
    const t = get(file, id);
    let ev: NewEvent;
    if (state === "needs_you" && t.state === "needs_you") {
      t.updatedAt = now;
      ev = { type: "task.updated", task: id, data: { needsYouReason: line, report: reportPath } };
    } else {
      if (!ACTIVE_STATES.includes(t.state)) {
        throw new HcoordError(`${id} is ${t.state}; only a started task can report`);
      }
      ev = transition(t, state, now, { report: reportPath });
    }
    if (state === "needs_you") {
      t.needsYouReason = line;
      t.needsYouAuto = false;
    } else {
      t.summary = line;
    }
    mkdirSync(paths.reports(slug), { recursive: true });
    appendFileSync(reportPath, `## ${state} · ${now}\n\n${text.trim()}\n\n`);
    return { result: { ...t }, events: [ev] };
  });
  const parent = notifyTarget(meta, updated);

  const out: Outcome = { ok: true, lines: [`${id} → ${state}; report saved to ${reportPath}`] };
  // Done work goes into its worktree's branch at once, so the next task starts from it.
  let merged = "";
  let cleanupMerged = false;
  if (state === "done") {
    // Whatever happens here, the coordinator is still told and the queue still moves.
    let m: Outcome & { nothing?: boolean };
    try {
      m = await mergeTask(id, { quiet: true });
    } catch (e) {
      const error = errText(e);
      await mutate(slug, ({ file, now }) => {
        const t = get(file, id);
        if (t.state !== "done") return { result: null, events: [] };
        t.mergeError = error;
        t.updatedAt = now;
        return { result: null, events: [{ type: "task.merge_failed", task: id, data: { error } }] };
      });
      m = { ok: false, lines: [error] };
    }
    out.lines.push(...m.lines);
    cleanupMerged = m.ok && !!task.cleanup;
    const into = meta.lanes[task.lane]?.branch ?? task.lane;
    merged = !m.ok ? ` (NOT merged: ${m.lines.at(-1)})` : m.nothing ? ` (nothing to merge: no commits that ${into} doesn't already have)` : ` (merged into ${into})`;
  }
  if (opts.notify !== false) {
    if (!parent) {
      out.lines.push("no coordinator terminal to notify");
    } else {
      const r = hcSend(parent, `${id} ${state}${merged}: ${line} (report: ${reportPath})`);
      out.lines.push(r.ok ? `notified the coordinator (${parent})` : `warning: couldn't notify ${parent}: ${r.error}`);
    }
  }
  // After the note above: this ends the coordinator it went to. The report itself stands either way.
  const finish = cleanupMerged ? await tryFinishRemoval(slug, id) : null;
  if (finish) {
    out.lines.push(...finish.lines);
    if (!finish.ok && parent && opts.notify !== false) hcSend(parent, `${id} merged, but ${finish.lines.at(-1)}`);
  }
  if (state !== "needs_you") {
    const s = await schedule(slug, parent ? { lane: task.lane, address: parent } : undefined);
    out.lines.push(...s.lines);
    out.ok &&= s.ok;
  }
  stopAfterRemoval(finish, out.lines);
  return out;
}

/** Answers a needs_you task: sends the text to its worker, then marks it working again. */
export async function replyTask(idArg: string, text: string): Promise<Outcome> {
  if (!text.trim()) throw new UsageError("the reply is empty");
  const { meta, task } = findTask(idArg);
  if (task.state !== "needs_you") throw new HcoordError(`${task.id} is ${task.state}, not needs_you`);
  const h = ourTerminal(task);
  if (!h || h.state !== "live") throw new HcoordError(`${task.id}'s worker terminal is gone; cancel and reopen the task instead`);
  const r = hcSend(h.address, text);
  if (!r.ok) throw new HcoordError(`couldn't send to ${h.address}: ${r.error}`);
  await mutate(meta.slug, ({ file, now }) => {
    const t = get(file, task.id);
    if (t.state !== "needs_you") return { result: null, events: [] };
    return { result: null, events: [transition(t, "working", now, { by: "reply" })] };
  });
  return { ok: true, lines: [`sent to ${task.terminal!.name} (${h.address}); ${task.id} → working`] };
}

// ---------------------------------------------------------------- merging back

/** finishRemoval, turning anything thrown into a failure: whatever called has its own work to complete. */
async function tryFinishRemoval(slug: string, id: string): ReturnType<typeof finishRemoval> {
  try {
    return await finishRemoval(slug, id);
  } catch (e) {
    return { ok: false, lines: [`the worktree wasn't removed: ${errText(e)}`] };
  }
}

/** Stops a removed worktree's coordinator: the last thing to do, as it may be what's running us. */
function stopAfterRemoval(finish: Awaited<ReturnType<typeof finishRemoval>>, lines: string[]): void {
  const s = finish && stop(finish.coordinator);
  if (s) lines.push(s);
}

/**
 * Merges a done task's branch into its worktree's branch (in the worktree). One merge per worktree
 * at a time. A conflict leaves everything as it was and the task done with `mergeError`.
 * A merged cleanup task finishes its worktree's removal, even if it was merged earlier and the removal
 * failed then. `quiet`: the caller (report) does that and starts queued tasks itself.
 */
export async function mergeTask(idArg: string, opts: { quiet?: boolean } = {}): Promise<Outcome & { nothing?: boolean }> {
  const { meta, task } = findTask(idArg);
  const id = task.id;
  if (task.state === "merged") {
    const lines = [`${id} is already merged`];
    return task.cleanup && !opts.quiet ? afterMerge(meta.slug, task, lines) : { ok: true, lines };
  }
  if (task.state !== "done") throw new HcoordError(`${id} is ${task.state}; only done tasks are merged`);
  const lane = laneOf(meta, task.lane);
  if (!existsSync(lane.path)) throw new HcoordError(`${id}'s worktree ${lane.path} is gone`);
  const result = await withLock(join(paths.project(meta.slug), `.merge-${task.lane}.lock`), () => mergeBranch(lane.path, task.branch));
  await mutate(meta.slug, ({ file, now }) => {
    const t = get(file, id);
    if (t.state !== "done") return { result: null, events: [] };
    if (result.ok) {
      if (result.nothing) delete t.mergeCommit;
      else t.mergeCommit = result.commit;
      return { result: null, events: [transition(t, "merged", now, { into: result.into, commit: result.nothing ? null : result.commit, nothing: !!result.nothing })] };
    }
    t.mergeError = result.error;
    t.updatedAt = now;
    return { result: null, events: [{ type: "task.merge_failed", task: id, data: { error: result.error } }] };
  });
  if (result.ok) {
    const lines = [
      result.nothing
        ? `nothing to merge: ${task.branch} has no commits that ${result.into} doesn't already have`
        : `merged ${task.branch} into ${result.into} (${result.commit}) in ${lane.path}`,
    ];
    if (opts.quiet) return { ok: true, lines, nothing: !!result.nothing };
    return { ...(await afterMerge(meta.slug, task, lines)), nothing: !!result.nothing };
  }
  return { ok: false, lines: [result.error] };
}

/** `task merge`'s last steps: a cleanup task's removal, then whatever can start now. */
async function afterMerge(slug: string, task: Task, lines: string[]): Promise<Outcome> {
  const finish = task.cleanup ? await tryFinishRemoval(slug, task.id) : null;
  if (finish) lines.push(...finish.lines);
  const s = await schedule(slug);
  lines.push(...s.lines);
  stopAfterRemoval(finish, lines);
  return { ok: finish?.ok ?? true, lines };
}

// ---------------------------------------------------------------- cancel / clean

export async function cancelTask(idArg: string): Promise<Outcome> {
  const { meta, task } = findTask(idArg);
  const id = task.id;
  const term = ourTerminal(task);
  await mutate(meta.slug, ({ file, now }) => {
    const t = get(file, id);
    // A failed or done cleanup task can go too: that's how to keep a worktree after all.
    const given = t.cleanup ? abandonCleanup(t, now) : null;
    if (given) return { result: null, events: [given] };
    if (FINAL_STATES.includes(t.state)) throw new HcoordError(`${id} is already ${t.state}`);
    return { result: null, events: [transition(t, "cancelled", now)] };
  });
  const out: Outcome = { ok: true, lines: [`${id} cancelled${task.worktree ? `; worktree kept at ${task.worktree}` : ""}`] };
  if (task.cleanup && (await clearRemoval(meta.slug, task.lane, id))) {
    out.lines.push(`the removal of worktree ${task.lane} is called off; it stays`);
  }
  if (term?.state === "live") {
    const k = hcKill(term.address);
    out.lines.push(k.ok ? `stopped ${term.name} (${term.address})` : `warning: couldn't stop ${term.address}: ${k.error}`);
  }
  const s = await schedule(meta.slug, task.parent ? { lane: task.lane, address: task.parent } : undefined);
  out.lines.push(...s.lines);
  out.ok &&= s.ok;
  return out;
}

/** Removes a finished task's worktree, only if git says it is clean and merged. Keeps the branch. */
export async function cleanTask(idArg: string): Promise<Outcome> {
  const { meta, task } = findTask(idArg);
  const id = task.id;
  if (!FINAL_STATES.includes(task.state)) {
    throw new HcoordError(`${id} is ${task.state}; only merged, done, failed or cancelled tasks can be cleaned`);
  }
  if (!task.worktree) throw new HcoordError(`${id} has no worktree`);
  const lines: string[] = [];
  if (existsSync(task.worktree)) {
    const dirty = dirtyFiles(task.worktree);
    if (dirty) throw new HcoordError(`${task.worktree} has uncommitted changes; not removing it:\n${dirty}`);
    const lanePath = meta.lanes[task.lane]?.path ?? task.repo;
    const { target, merged } = mergedInto(lanePath, task.branch);
    if (!merged) {
      throw new HcoordError(`${task.branch} isn't merged into ${target} in ${lanePath}; not removing the worktree (hcoord task merge ${id})`);
    }
    const term = ourTerminal(task);
    if (term) {
      if (term.state === "live") hcKill(term.address);
      hcRm(term.address);
      lines.push(`removed terminal ${term.name} (${term.address})`);
    }
    removeWorktree(task.repo, task.worktree);
    lines.push(`removed worktree ${task.worktree}; branch ${task.branch} kept`);
  } else {
    lines.push(`worktree ${task.worktree} was already gone`);
  }
  await mutate(meta.slug, ({ file, now }) => {
    const t = get(file, id);
    const worktree = t.worktree;
    delete t.worktree;
    t.updatedAt = now;
    return { result: null, events: [{ type: "task.cleaned", task: id, data: { worktree, branch: t.branch } }] };
  });
  return { ok: true, lines };
}

// ---------------------------------------------------------------- reconcile with the core

function describeExit(h: HcTerminal): string {
  if (h.exit_code != null) return `exit ${h.exit_code}`;
  if (h.signal != null) return `signal ${h.signal}`;
  return h.reason ?? "unknown reason";
}

const LAUNCH_GRACE_MS = 120_000;
/** A Claude worker silent for this long is probably stuck at a dialog. */
const SILENT_MS = 90_000;

interface Change {
  id: string;
  from: TaskState;
  address?: string;
  to: TaskState;
  reason: string;
  auto?: boolean;
  /** The worker's terminal is gone: retryable. */
  lost?: boolean;
}

/**
 * Brings task states in line with what the core reports, never rerunning anything:
 * a worker terminal that is gone or finished without a report → failed; one that is blocked or
 * errored, or stopped its turn without reporting → needs_you; back to working once it works again.
 */
export async function reconcile(slug: string): Promise<Outcome> {
  const active = loadTasks(slug).tasks.filter((t) => ACTIVE_STATES.includes(t.state));
  if (!active.length) return { ok: true, lines: [] };
  let terms: HcTerminal[];
  try {
    terms = hcList({ "hcoord.project": slug });
  } catch (e) {
    return { ok: true, lines: [`warning: couldn't reach herdr-core, worker states not checked: ${errText(e)}`] };
  }
  const byAddr = new Map(terms.map((h) => [h.address, h]));
  // Claude reports a status within seconds of starting; plain programs never do.
  const claudeWorkers = loadConfig().agent.kind === "claude";
  const changes: Change[] = [];
  for (const t of active) {
    if (!t.terminal) {
      if (t.state === "starting" && Date.now() - Date.parse(t.updatedAt) > LAUNCH_GRACE_MS) {
        changes.push({ id: t.id, from: t.state, to: "failed", reason: "its launch never finished" });
      }
      continue;
    }
    const a = t.terminal.address;
    const h = byAddr.get(a);
    const read = `hc read ${a}`;
    if (!h || (h.name ?? null) !== t.terminal.name) {
      changes.push({
        id: t.id, from: t.state, address: a, to: "failed", lost: true,
        reason: `worker terminal ${t.terminal.name} (${a}) no longer exists (a restart?); hcoord task retry ${t.id} picks it up again`,
      });
    } else if (h.state === "finished") {
      changes.push({ id: t.id, from: t.state, address: a, to: "failed", reason: `worker exited without reporting (${describeExit(h)}); ${read}` });
    } else if (t.state === "working" && (h.status === "blocked" || h.status === "error")) {
      const why = h.status === "blocked" ? "worker is blocked (a permission prompt or question)" : "worker's agent reported an error";
      changes.push({ id: t.id, from: t.state, address: a, to: "needs_you", reason: `${why}; ${read}`, auto: true });
    } else if (t.state === "working" && (h.status === "idle" || h.status === "done") && (h.turn ?? 0) >= 1) {
      changes.push({ id: t.id, from: t.state, address: a, to: "needs_you", reason: `worker stopped without reporting; ${read}`, auto: true });
    } else if (
      t.state === "working" &&
      !h.status &&
      claudeWorkers &&
      Date.now() - Date.parse(t.updatedAt) > SILENT_MS
    ) {
      changes.push({
        id: t.id, from: t.state, address: a, to: "needs_you", auto: true,
        reason: `worker hasn't reported any status after ${SILENT_MS / 1000} s (a trust or login prompt?); ${read}`,
      });
    } else if (t.state === "needs_you" && t.needsYouAuto && h.status === "working") {
      changes.push({ id: t.id, from: t.state, address: a, to: "working", reason: "worker is working again" });
    }
  }
  if (!changes.length) return { ok: true, lines: [] };
  const applied = await mutate(slug, ({ file, now }) => {
    const done: string[] = [];
    const events: NewEvent[] = [];
    for (const c of changes) {
      const t = get(file, c.id);
      if (t.state !== c.from || t.terminal?.address !== c.address) continue; // changed meanwhile
      events.push(transition(t, c.to, now, { by: "reconcile", reason: c.reason }));
      if (c.to === "failed") {
        t.summary = c.reason;
        if (c.lost) t.lostWorker = true;
      }
      if (c.to === "needs_you") {
        t.needsYouReason = c.reason;
        t.needsYouAuto = !!c.auto;
      }
      done.push(`${c.id}: ${c.from} → ${c.to} (${c.reason})`);
    }
    return { result: done, events };
  });
  return { ok: true, lines: applied };
}

/** Reconcile with the core, then start whatever can start. Run by `task list`. */
export async function sync(slug: string): Promise<Outcome> {
  const r = await reconcile(slug);
  const s = await schedule(slug);
  return { ok: r.ok && s.ok, lines: [...r.lines, ...s.lines] };
}
