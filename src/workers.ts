import { appendFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderWorkerBrief } from "./brief.ts";
import { loadConfig } from "./config.ts";
import { HcoordError, UsageError } from "./errors.ts";
import { dirtyFiles, ensureWorktree, mergedInto, removeWorktree } from "./git.ts";
import { hcGet, hcKill, hcList, hcRm, hcRunBg, hcSend, type HcTerminal } from "./hc.ts";
import { ACTIVE_STATES, FINAL_STATES, transition, workerName, type Task, type TaskState } from "./model.ts";
import { paths } from "./paths.ts";
import { byNumber } from "./render.ts";
import { findTask, loadProject, loadTasks, mutate, type NewEvent, type ProjectMeta } from "./store.ts";

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

/** Dependencies not yet done, as "ID (state)". */
function pendingDeps(task: Task, tasks: Task[]): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return task.dependsOn
    .filter((d) => byId.get(d)?.state !== "done")
    .map((d) => `${d} (${byId.get(d)?.state ?? "missing"})`);
}

const activeCount = (tasks: Task[]) => tasks.filter((t) => ACTIVE_STATES.includes(t.state)).length;

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
 * The coordinator terminal a new worker reports to (its hc parent): an explicit --parent, else the
 * project's coordinator, else `fallback` (the reporting worker's coordinator), else the caller when
 * the caller isn't one of our workers. Never a worker: that would send notes to the wrong agent.
 */
export function resolveParent(meta: ProjectMeta, explicit?: string, fallback?: string): string | null {
  if (explicit) {
    const h = hcGet(explicit);
    if (!h || h.state !== "live") throw new HcoordError(`--parent ${explicit} isn't a live terminal`);
    return h.address;
  }
  for (const c of [meta.coordinator?.address, fallback]) {
    if (!c) continue;
    const h = hcGet(c);
    if (h?.state === "live" && !h.labels?.["hcoord.task"]) return h.address;
  }
  const caller = process.env.HC_TERMINAL_ID;
  if (caller) {
    const h = hcGet(caller);
    if (h?.state === "live" && !h.labels?.["hcoord.task"]) return h.address;
  }
  return null;
}

// ---------------------------------------------------------------- launching

/** Creates the worktree and starts the worker for a task already claimed as `starting`. */
async function launch(slug: string, id: string, parent: string | null): Promise<Outcome> {
  const meta = loadProject(slug);
  const config = loadConfig();
  const task = get(loadTasks(slug), id);
  const wt = join(config.worktreeRoot, slug, id.toLowerCase());
  try {
    mkdirSync(dirname(wt), { recursive: true });
    const { base } = ensureWorktree(task.repo, wt, task.branch);
    const worktree = realpathSync(wt);
    const prompt = renderWorkerBrief({ meta, task, worktree, coordinator: parent });
    const term = hcRunBg({
      name: workerName(id),
      cwd: worktree,
      argv: [...config.agent.command, prompt],
      parent,
      labels: { "hcoord.project": slug, "hcoord.task": id },
    });
    const stillStarting = await mutate(slug, ({ file, now }) => {
      const t = get(file, id);
      Object.assign(t, { worktree, base, terminal: term, updatedAt: now });
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
    return {
      ok: true,
      lines: [`started ${id}: ${term.name} (${term.address}) in ${worktree}${parent ? `, reporting to ${parent}` : ", no coordinator"}`],
    };
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
export async function schedule(slug: string, fallbackParent?: string): Promise<Outcome> {
  if (!loadTasks(slug).tasks.some((t) => t.state === "queued")) return { ok: true, lines: [] };
  const max = loadConfig().maxParallel;
  const claimed = await mutate(slug, ({ file, now }) => {
    let running = activeCount(file.tasks);
    const ids: string[] = [];
    const events: NewEvent[] = [];
    for (const t of file.tasks.filter((x) => x.state === "queued").sort(byNumber)) {
      if (running >= max) break;
      if (pendingDeps(t, file.tasks).length) continue;
      events.push(transition(t, "starting", now, { by: "scheduler" }));
      ids.push(t.id);
      running++;
    }
    return { result: ids, events };
  });
  const out: Outcome = { ok: true, lines: [] };
  if (!claimed.length) return out;
  const parent = resolveParent(loadProject(slug), undefined, fallbackParent);
  for (const id of claimed) {
    const r = await launch(slug, id, parent);
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
  const parent = resolveParent(meta, opts.parent);
  const decision = await mutate(slug, ({ file, now }) => {
    const t = get(file, id);
    if (ACTIVE_STATES.includes(t.state)) {
      throw new HcoordError(`${id} is already ${t.state}${t.terminal ? ` (${t.terminal.name}, ${t.terminal.address})` : ""}`);
    }
    if (t.state !== "todo" && t.state !== "queued") {
      throw new HcoordError(`${id} is ${t.state}; only todo or queued tasks can start`);
    }
    const waits = pendingDeps(t, file.tasks);
    const running = activeCount(file.tasks);
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
  const line = summaryOf(text);
  const reportPath = join(paths.reports(slug), `${id}.md`);

  const parent = await mutate(slug, ({ file, now }) => {
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
    return { result: t.parent ?? meta.coordinator?.address ?? null, events: [ev] };
  });

  const out: Outcome = { ok: true, lines: [`${id} → ${state}; report saved to ${reportPath}`] };
  if (opts.notify !== false) {
    if (!parent) {
      out.lines.push("no coordinator terminal to notify");
    } else {
      const r = hcSend(parent, `${id} ${state}: ${line} (report: ${reportPath})`);
      out.lines.push(r.ok ? `notified the coordinator (${parent})` : `warning: couldn't notify ${parent}: ${r.error}`);
    }
  }
  if (state !== "needs_you") {
    const s = await schedule(slug, parent ?? undefined);
    out.lines.push(...s.lines);
    out.ok &&= s.ok;
  }
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

// ---------------------------------------------------------------- cancel / clean

export async function cancelTask(idArg: string): Promise<Outcome> {
  const { meta, task } = findTask(idArg);
  const id = task.id;
  const term = ourTerminal(task);
  await mutate(meta.slug, ({ file, now }) => {
    const t = get(file, id);
    if (FINAL_STATES.includes(t.state)) throw new HcoordError(`${id} is already ${t.state}`);
    return { result: null, events: [transition(t, "cancelled", now)] };
  });
  const out: Outcome = { ok: true, lines: [`${id} cancelled${task.worktree ? `; worktree kept at ${task.worktree}` : ""}`] };
  if (term?.state === "live") {
    const k = hcKill(term.address);
    out.lines.push(k.ok ? `stopped ${term.name} (${term.address})` : `warning: couldn't stop ${term.address}: ${k.error}`);
  }
  const s = await schedule(meta.slug, task.parent);
  out.lines.push(...s.lines);
  out.ok &&= s.ok;
  return out;
}

/** Removes a finished task's worktree, only if git says it is clean and merged. Keeps the branch. */
export async function cleanTask(idArg: string): Promise<Outcome> {
  const { meta, task } = findTask(idArg);
  const id = task.id;
  if (!FINAL_STATES.includes(task.state)) {
    throw new HcoordError(`${id} is ${task.state}; only done, failed or cancelled tasks can be cleaned`);
  }
  if (!task.worktree) throw new HcoordError(`${id} has no worktree`);
  const lines: string[] = [];
  if (existsSync(task.worktree)) {
    const dirty = dirtyFiles(task.worktree);
    if (dirty) throw new HcoordError(`${task.worktree} has uncommitted changes; not removing it:\n${dirty}`);
    const { target, merged } = mergedInto(task.repo, task.branch);
    if (!merged) {
      throw new HcoordError(`${task.branch} isn't merged into ${target} in ${task.repo}; not removing the worktree (hcoord never merges)`);
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

interface Change {
  id: string;
  from: TaskState;
  address?: string;
  to: TaskState;
  reason: string;
  auto?: boolean;
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
      changes.push({ id: t.id, from: t.state, address: a, to: "failed", reason: `worker terminal ${t.terminal.name} (${a}) no longer exists` });
    } else if (h.state === "finished") {
      changes.push({ id: t.id, from: t.state, address: a, to: "failed", reason: `worker exited without reporting (${describeExit(h)}); ${read}` });
    } else if (t.state === "working" && (h.status === "blocked" || h.status === "error")) {
      const why = h.status === "blocked" ? "worker is blocked (a permission prompt or question)" : "worker's agent reported an error";
      changes.push({ id: t.id, from: t.state, address: a, to: "needs_you", reason: `${why}; ${read}`, auto: true });
    } else if (t.state === "working" && (h.status === "idle" || h.status === "done") && (h.turn ?? 0) >= 1) {
      changes.push({ id: t.id, from: t.state, address: a, to: "needs_you", reason: `worker stopped without reporting; ${read}`, auto: true });
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
      if (c.to === "failed") t.summary = c.reason;
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
