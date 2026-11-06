import { appendFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { coordinatorArgv } from "./agents.ts";
import { loadConfig } from "./config.ts";
import { HcoordError } from "./errors.ts";
import { withLock } from "./fsutil.ts";
import { hcGet, hcKill, hcRunBg, type HcTerminal } from "./hc.ts";
import { findTranscript } from "./log.ts";
import { isWorkerBranch, LANE_RE, ROOT_LANE, slugify } from "./model.ts";
import { paths } from "./paths.ts";
import {
  checkoutOf,

  loadProject,
  loadTasks,
  projectForRepo,
  updateMeta,
  type CoordinatorRef,
  type ProjectMeta,
} from "./store.ts";
import {
  classifyCoordinator,
  coordinatorState,
  foregroundProgram,
  laneOf,
  recordedCoordinator,
  retryTask,
  sync,
  trustWarnings,
  type Outcome,
} from "./workers.ts";

/** hc terminal name of a worktree's coordinator ([a-z0-9_-]{1,32}). */
export const coordinatorName = (meta: ProjectMeta, lane: string) =>
  `coord-${meta.prefix.toLowerCase()}-${lane}`.slice(0, 32).replace(/-+$/, "");

/** Runs a herdr-app command; null result means the app isn't reachable. */
function app(args: string[]): any | null {
  try {
    const r = Bun.spawnSync(["herdr-app", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    if (r.exitCode !== 0) return null;
    const t = r.stdout.toString().trim();
    return t ? JSON.parse(t) : {};
  } catch {
    return null;
  }
}

/** The space to put a coordinator in: one whose folder is that worktree, else the shown one. */
function pickSpace(path: string): string | null {
  const ls = app(["ls"]);
  if (!ls?.spaces) return null;
  const local = ls.spaces.filter((s: any) => !s.machine);
  const here = local.find((s: any) => s.folder === path);
  if (here) return here.id;
  const status = app(["status"]);
  return status?.space ?? local[0]?.id ?? null;
}

/** A space id Herdr hasn't seen (its own are "sp" and 32 hex digits). */
const newSpaceId = () => `sp${crypto.randomUUID().replace(/-/g, "")}`;

function tabOf(address: string): string | null {
  const ls = app(["ls"]);
  for (const s of ls?.spaces ?? []) {
    for (const t of s.tabs ?? []) if (t.terminals?.some((x: any) => x.terminal === address)) return t.id;
  }
  return null;
}

// ---------------------------------------------------------------- worktrees

/**
 * The project and worktree key for a checkout path, registering the worktree the first time.
 * The main checkout is "root"; a linked worktree is keyed by its branch.
 */
export async function laneForPath(path: string): Promise<{ meta: ProjectMeta; lane: string }> {
  const co = checkoutOf(path);
  const meta = projectForRepo(co.main);
  if (!meta) {
    throw new HcoordError(`${co.main} isn't a project yet: hcoord project new ${basename(co.main)} --repo ${co.main}`);
  }
  const wtRoot = loadConfig().worktreeRoot;
  if (co.top.startsWith(wtRoot + "/") || (co.top !== meta.repo && isWorkerBranch(co.branch))) {
    throw new HcoordError(`${co.top} is a worker's checkout, not a worktree to coordinate`);
  }
  if (co.top === meta.repo) return { meta, lane: ROOT_LANE };
  const known = Object.entries(meta.lanes).find(([, l]) => l.path === co.top);
  if (known) return { meta, lane: known[0] };

  const lane = await updateMeta(meta.slug, (m) => {
    const again = Object.entries(m.lanes).find(([, l]) => l.path === co.top);
    if (again) return { result: again[0] };
    const stem = slugify(co.branch ?? basename(co.top), 36) || "worktree";
    let key = stem === ROOT_LANE ? `${stem}-2` : stem;
    for (let n = 2; m.lanes[key]; n++) key = `${stem}-${n}`;
    if (!LANE_RE.test(key)) throw new HcoordError(`can't make a worktree key from ${co.branch ?? co.top}`);
    m.lanes[key] = { path: co.top, branch: co.branch, createdAt: new Date().toISOString() };
    return { result: key, event: { type: "lane.created", data: { lane: key, path: co.top, branch: co.branch } } };
  });
  return { meta: loadProject(meta.slug), lane };
}

async function saveCoordinator(slug: string, lane: string, c: CoordinatorRef | null): Promise<void> {
  await updateMeta(slug, (m) => {
    const l = laneOf(m, lane);
    if (c) l.coordinator = c;
    else delete l.coordinator;
    return { result: null, event: { type: "coordinator.set", data: { lane, ...(c ?? {}) } } };
  });
}

/** Why a coordinator can't be opened in a terminal something else occupies, and how to get it back. */
function occupiedRefusal(t: HcTerminal, name: string, path: string, resumes: boolean): string[] {
  const here = `in ${name} (${t.address}), not the coordinator`;
  const then = `(see it with: hc attach ${t.address}), then: hcoord lane open ${path}`;
  if (foregroundProgram(t) === "claude") {
    return [
      `A plain Claude, started by hand, is running ${here}. hcoord won't stop it.`,
      `/exit it ${then}`,
      resumes
        ? "The coordinator's saved conversation comes back, not this session, which stays in its own transcript."
        : "That starts a new conversation. This session stays in its own transcript.",
    ];
  }
  const cmd = t.foreground?.argv.join(" ");
  const what = cmd ? `\`${cmd.length > 60 ? cmd.slice(0, 59) + "…" : cmd}\`` : "Something else";
  return [`${what} is running ${here}. hcoord won't stop it.`, `Exit it ${then}`];
}

/**
 * Ends a terminal so its name can be used again. `hc kill` closes even a kept terminal and returns
 * once it has finished (it hangs up, then terminates, then kills), so only a failed kill leaves it live.
 */
function stopTerminal(t: HcTerminal, name: string): void {
  const k = hcKill(t.address);
  if (hcGet(t.address)?.state === "live") throw new HcoordError(`couldn't stop ${name} (${t.address}): ${k.error ?? "it's still running"}`);
}

export interface OpenOptions {
  /** Show it in Herdr (default true). */
  show?: boolean;
  /** The Herdr space for it (default: the one whose folder is the worktree, else the shown one). */
  space?: string;
  /**
   * Show it in a new Herdr space of its own, with this name. Herdr makes a space for a labelled
   * terminal whose space id it doesn't know, so the coordinator is the space's first and only tab:
   * no shell shows before it, as it would in a space made with space.new.
   */
  newSpace?: string;
  /**
   * Replace a coordinator that reports no status (one that's only a shell now is replaced anyway).
   * What someone started in that shell is never stopped, with or without this.
   */
  restart?: boolean;
  /** Start a new conversation even when an earlier session could be resumed. */
  fresh?: boolean;
  /**
   * Show it in Herdr (its tab, its new space named) but leave the focus where it is: the caller then
   * focuses `terminal` itself, once, when it's ready (hcoord's New worktree dialog closes first).
   */
  noFocus?: boolean;
}

/** What openLane did, and the coordinator's terminal (when there is one) for a caller to focus. */
export interface LaneOutcome extends Outcome {
  terminal?: string;
}

/**
 * Starts a worktree's coordinator agent (or shows the running one) in a Herdr tab named
 * "coord <worktree>", in that worktree's folder. Without a Herdr window it runs headless.
 */
export async function openLane(project: string, laneKey: string, opts: OpenOptions = {}): Promise<LaneOutcome> {
  let meta = loadProject(project);
  const slug = meta.slug;
  const lane = laneOf(meta, laneKey);
  if (!existsSync(lane.path)) throw new HcoordError(`worktree ${laneKey} (${lane.path}) is gone`);
  const name = coordinatorName(meta, laneKey);
  const claude = loadConfig().agent.kind === "claude";
  const lines: string[] = [];

  // The recorded terminal, or (the project was made again, its record lost) a terminal holding our name.
  const recorded = recordedCoordinator(meta, laneKey);
  const named = recorded ? null : hcGet(name);
  const term = recorded ?? (named?.state === "live" ? named : null);
  if (term && !recorded) {
    // An earlier coordinator of this same worktree carries our labels. Anything else is someone else's.
    const l = term.labels ?? {};
    const ours = l["hcoord.project"] === slug && l["hcoord.lane"] === laneKey && l["hcoord.role"] === "coordinator";
    if (!ours) {
      throw new HcoordError(`a terminal named ${name} is running but isn't this worktree's coordinator; stop it (hc kill ${name}) first`);
    }
  }
  // Carry on the earlier conversation when there was one and its transcript is still there.
  const earlier = meta.lanes[laneKey]?.coordinator?.session;
  const resumes = () => claude && !opts.fresh && !!earlier && !!findTranscript(earlier);
  const state = classifyCoordinator(term, slug, claude);
  if (state === "occupied") return { ok: false, lines: occupiedRefusal(term!, name, lane.path, resumes()) };
  if (state === "prompt" && recorded && !opts.restart) {
    return {
      ok: false,
      lines: [
        `${name} (${term!.address}) is running but reports no agent status: it may be at a prompt, such as Claude's trust question, or still starting.`,
        `Look with: hc attach ${term!.address}. To replace it: hcoord lane open ${lane.path} --restart`,
      ],
    };
  }
  if (state === "running") {
    if (!recorded) await saveCoordinator(slug, laneKey, { address: term!.address, name });
    const shown = opts.show !== false && (opts.noFocus || app(["do", "agent.focus", "--terminal", term!.address]) !== null);
    const what = recorded ? `coordinator ${name} (${term!.address}) is already running` : `took back the running coordinator ${name} (${term!.address})`;
    lines.push(`${what}${shown && !opts.noFocus ? "; showing it" : ""}`);
    if (!shown) lines.push(`attach with: hc attach ${term!.address}`);
    return { ok: true, lines, terminal: term!.address };
  }
  if (state === "shell" || state === "prompt") {
    stopTerminal(term!, name);
    const why = state === "shell" ? "only a shell now (after a restart?)" : "reporting no agent status";
    lines.push(`stopped ${name} (${term!.address}): ${recorded ? "" : "an earlier coordinator of this worktree, "}${why}`);
  }

  const resume = resumes();
  const session = claude ? (resume ? earlier! : crypto.randomUUID()) : undefined;

  const newSpace = opts.show !== false && !!opts.newSpace && app(["status"]) !== null;
  const space = opts.show === false ? null : newSpace ? newSpaceId() : (opts.space ?? pickSpace(lane.path));
  const tab = space ? `tbhcoord${(slug + laneKey).replace(/[^a-z0-9]/g, "")}${Date.now().toString(36)}` : null;
  const labels: Record<string, string> = { "hcoord.project": slug, "hcoord.lane": laneKey, "hcoord.role": "coordinator" };
  if (space && tab) Object.assign(labels, { "herdr.space": space, "herdr.tab": tab });

  // No parent: it must outlive whoever opened it. Keep: a lost coordinator comes back as a shell
  // (never a rerun), and opening it again resumes it.
  const argv = coordinatorArgv(loadConfig(), slug, laneKey, name, session, resume);
  const started = hcRunBg({ name, cwd: lane.path, argv, labels, parent: null, keep: true });
  await saveCoordinator(slug, laneKey, { ...started, ...(session ? { session } : {}) });
  lines.push(`${resume ? "resumed" : "started"} coordinator ${name} (${started.address}) in ${lane.path}`);

  if (space && tab) {
    // Herdr adopts labelled terminals within a moment; then name the tab and show it.
    let adopted = false;
    for (let i = 0; i < 40 && !adopted; i++) {
      adopted = tabOf(started.address) === tab;
      if (!adopted) await Bun.sleep(150);
    }
    if (adopted) {
      // Name the space and the tab before anything shows them, then (unless the caller focuses it) go there.
      if (newSpace) app(["do", "space.rename", "--id", space, "--name", opts.newSpace!]);
      app(["do", "tab.rename", "--id", tab, "--name", `coord ${laneKey}`]);
      if (!opts.noFocus) {
        if (newSpace) app(["do", "space.select", "--id", space]);
        app(["do", "agent.focus", "--terminal", started.address]);
      }
      lines.push(`${opts.noFocus ? "in" : "showing it in"} the tab "coord ${laneKey}"`);
    } else {
      lines.push(`Herdr didn't show it yet; attach with: hc attach ${started.address}`);
    }
  } else {
    const why = opts.show === false ? "not shown in Herdr (--no-show)" : "no Herdr window found";
    lines.push(`${why}; attach with: hc attach ${started.address}`);
  }
  meta = loadProject(slug);
  lines.push(...trustWarnings(meta));
  return { ok: true, lines, terminal: started.address };
}

/** Appends a dated bullet to the project's MEMORY.md (the coordinators' shared notes). */
export async function addMemory(project: string, text: string): Promise<Outcome> {
  const meta = loadProject(project);
  const note = text.replace(/\s+/g, " ").trim();
  if (!note) throw new HcoordError("nothing to remember", 2);
  await withLock(paths.lock(meta.slug), () => {
    appendFileSync(paths.memoryMd(meta.slug), `- ${new Date().toISOString().slice(0, 10)}: ${note}\n`);
  });
  return { ok: true, lines: [`noted in ${paths.memoryMd(meta.slug)}`] };
}

/**
 * After a reboot (or a core restart): checks workers, brings back each worktree's coordinator that
 * had one (resuming its conversation) unless its terminal is in use or it's at a prompt, and restarts
 * tasks whose worker vanished, in their checkouts, with what's there so far.
 */
export async function recoverProject(project: string, opts: { show?: boolean } = {}): Promise<Outcome> {
  const slug = loadProject(project).slug;
  const out: Outcome = { ok: true, lines: [] };
  const add = (o: Outcome) => {
    out.lines.push(...o.lines);
    out.ok &&= o.ok;
  };
  add(await sync(slug));
  const meta = loadProject(slug);
  for (const [key, lane] of Object.entries(meta.lanes)) {
    if (!lane.coordinator) continue;
    if (!existsSync(lane.path)) {
      out.lines.push(`worktree ${key} (${lane.path}) is gone; its coordinator isn't restarted`);
      continue;
    }
    if (coordinatorState(meta, key) === "running") {
      const { name, address } = lane.coordinator;
      out.lines.push(`${key}: coordinator ${name} (${address}) is running`);
    } else {
      // Refuses, and says why, when something else runs in the coordinator's terminal or it's at a
      // prompt. Replacing a prompt wouldn't get past a trust question, and would kill one still starting.
      try {
        add(await openLane(slug, key, { show: opts.show }));
      } catch (e) {
        out.ok = false;
        out.lines.push(`${key}: couldn't restart its coordinator: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  const lost = loadTasks(slug).tasks.filter((t) => t.state === "failed" && t.lostWorker);
  for (const t of lost) {
    try {
      add(await retryTask(t.id));
    } catch (e) {
      out.ok = false;
      out.lines.push(`${t.id}: couldn't retry: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (!out.lines.length) out.lines.push("nothing to recover");
  return out;
}

