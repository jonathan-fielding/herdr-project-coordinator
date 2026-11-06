// Projects: hcoord's projects as a sidebar section, beside Spaces and Agents.
// A project is a repo; under it, its worktrees (the main checkout and Herdr's worktree
// spaces), each with a coordinator agent; under each worktree, its tasks by state.
// Click a worktree to go to its coordinator (started if it isn't running), a task to peek
// at its worker or read its log. Going to a project's worktree space starts its coordinator.
// The same mod with props { log } is a pane showing one agent's log (its transcript); with
// props { menu } a right-click menu, with props { ask } a dialog asking before a delete, with
// props { info } a dialog explaining a warning (where hcoord keeps its data), with props { newWorktree }
// the New worktree dialog (a new branch, its checkout, and a space holding only its coordinator), with
// props { gitInit } a dialog asking before a plain folder becomes a git repo and a project, and with
// props { settings } a project's settings dialog.
// Data: `hcoord board --json`, refreshed when ~/.herdr-coordinator/projects changes; workers'
// terminals changing makes hcoord check them (`hcoord sync`).
// Needs the hcoord CLI: `hcoord mod install` writes how to run it into hcoord-path.js, and without it
// this section only says how to set it up. Edit the copy in the hcoord repo, not this one.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, InputState, Input, TextareaState, Textarea, Scrollbar } from "gpui-base";
import {
  agents, terminals, panes, spaces, focused, run, exec, theme, notify, nextCommand,
  pickFolder, watchFolder, writeTextFile, layout, home, props, openOverlay, closeOverlay, shared, setShared,
} from "herdr";
import { HCOORD } from "./hcoord-path.js";

const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
// How long after one try a worktree's coordinator isn't started again by itself.
const RETRY_MS = 60000;
// How often a coordinator's log pane reloads.
const FALLBACK_MS = 30000;
// Changes the sidebar's folder watch can't see (Claude's trust list, new git worktrees, branch switches):
// looked for this often. A board run is ~50 ms, so this is cheap.
const SIDEBAR_FALLBACK_MS = 8000;
const ACTIVE = ["starting", "working", "needs_you"];
// While the CLI can't be run, how often to see whether that's changed.
const SETUP_RETRY_MS = 60000;
const SETUP_URL = "https://github.com/jonathan-fielding/herdr-project-coordinator";
// How long a merged cleanup task may wait for hcoord to remove its worktree before that counts as having failed.
const REMOVAL_GRACE_MS = 60000;
// Shared state: the pending removals whose end has been announced.
const ANNOUNCED = "hcoord.removals-announced";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
// The sidebar's rail goes by its width, as in the shipped sections.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

const within = (path, dir) => !!path && !!dir && (path === dir || path.startsWith(dir.replace(/\/+$/, "") + "/"));
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
const tilde = (path) => (within(path, home()) ? "~" + path.slice(home().length) : path);
const load = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
};

// Task sections, in the order they show.
const GROUPS = [
  { id: "needs_you", label: "Needs you", states: ["needs_you"], tone: "blocked" },
  { id: "working", label: "Working", states: ["starting", "working"], tone: "working" },
  { id: "queued", label: "Queued", states: ["queued"] },
  { id: "todo", label: "To do", states: ["todo"] },
  { id: "failed", label: "Failed", states: ["failed"], tone: "blocked" },
  { id: "unmerged", label: "Not merged", states: ["done"], tone: "blocked" },
  { id: "merged", label: "Merged", states: ["merged", "cancelled"], folded: true },
];

/** What an occupied coordinator's row and tooltip say. The row leads with the program, as it may be cut short. */
function occupiedWords({ program, session }) {
  const look = "Click: look at it";
  if (program === "claude") {
    const after = session
      ? "The coordinator's saved conversation comes back, not this session, which stays in its own transcript."
      : "That starts a new conversation. This session stays in its own transcript.";
    return {
      row: "Plain Claude running, not the coordinator",
      tip: `This Claude was started by hand and isn't the coordinator. To bring the coordinator back, /exit it, then click the worktree. ${after} ${look}`,
    };
  }
  if (program) {
    return {
      row: `${program} running, not the coordinator`,
      tip: `${program} is running in the coordinator's terminal. Exit it first, then click the worktree to start the coordinator. ${look}`,
    };
  }
  return {
    row: "Something else is running in its terminal: exit it first",
    tip: `Something else is running in the coordinator's terminal. Exit it first, then click the worktree to start the coordinator. ${look}`,
  };
}

/** A pending removal that won't finish by itself. A done task with no mergeError is only on its way to merged. */
function cleanupStuck(removing, task) {
  if (removing.state === "done") return !!task?.mergeError;
  // Merged, and the worktree still here for a while: git refused to remove it.
  if (removing.state === "merged") return Date.now() - Date.parse(task?.updatedAt ?? removing.since) > REMOVAL_GRACE_MS;
  return !removing.state || removing.state === "failed" || removing.state === "cancelled";
}

const removalKey = (project, task) => `${project}:${task}`;
/** Whether to announce a removal's end: yes once, whichever of the dialog and the sidebar copies gets there first. */
function claimRemoval(key) {
  const seen = shared(ANNOUNCED) ?? [];
  if (seen.includes(key)) return false;
  setShared(ANNOUNCED, [...seen, key]);
  return true;
}
const releaseRemoval = (key) => setShared(ANNOUNCED, (shared(ANNOUNCED) ?? []).filter((k) => k !== key));

/** hcoord's reasons end in "; hc read t7" or a command to run: the person has clicks for those. */
const plain = (s) => (s ?? "").replace(/;\s*(hc read \S+|hcoord task retry \S+.*)\s*$/, "");

/** A command's --json output, or null if it isn't any. */
const parsed = (stdout) => {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
};

/** Never rejects. `unavailable`: the CLI couldn't be run at all, as opposed to a command that failed. */
async function hcoord(args) {
  if (!HCOORD) return { ok: false, unavailable: true, text: `hcoord isn't set up: see ${SETUP_URL}`, stdout: "" };
  try {
    const r = await exec(HCOORD[0], [...HCOORD.slice(1), ...args]);
    const text = (r.stdout + r.stderr).trim();
    // 126/127: the program isn't there. Bun's error: it is, but the clone holding cli.ts has moved.
    const unavailable = r.code === 126 || r.code === 127 || (r.code !== 0 && /Module not found|Cannot find module/.test(r.stderr));
    return { ok: r.code === 0, unavailable, text, stdout: r.stdout };
  } catch (e) {
    return { ok: false, unavailable: true, text: String(e?.message ?? e), stdout: "" };
  }
}

/** hcoord given `text` as a file, since `exec` has no stdin: `args(file)` are its arguments. The file is in a
 *  private folder of its own and is gone afterwards. Never rejects. */
async function hcoordWithFile(text, args) {
  let dir = null;
  try {
    const made = await exec("mktemp", ["-d", "-t", "hcoord.XXXXXX"]);
    dir = made.code === 0 ? made.stdout.trim() : null;
    if (!dir) return { ok: false, text: `Couldn't make a temporary folder: ${made.stderr.trim()}`, stdout: "" };
    await writeTextFile(`${dir}/text`, text, null);
    return await hcoord(args(`${dir}/text`));
  } catch (e) {
    return { ok: false, text: String(e?.message ?? e), stdout: "" };
  } finally {
    if (dir) {
      await exec("rm", ["-f", `${dir}/text`]).catch(() => {});
      await exec("rmdir", [dir]).catch(() => {});
    }
  }
}

/** Makes a checkout with `hcoord lane checkout|new … --json`: { w } the worktree to go to, or { error }. */
async function makeCheckout(args) {
  const r = await hcoord([...args, "--json"]);
  let made = null;
  try {
    made = r.ok ? JSON.parse(r.stdout) : null;
  } catch {}
  if (!made?.path) return { error: (r.text || "hcoord failed").replace(/^hcoord: /, "") };
  return { w: { path: made.path, branch: made.branch, lane: { key: made.lane, path: made.path }, main: false } };
}

/** hcoord's New worktree dialog for a project: { project, name, defaultBranch }. */
const openNewWorktree = (n) => openOverlay({ mod: "hcoord", kind: "dialog", width: 460, height: 420, props: { newWorktree: n } });

/** hcoord's settings dialog for a project: { project, name }. */
const openSettings = (s) => openOverlay({ mod: "hcoord", kind: "dialog", width: 520, height: 420, props: { settings: s } });

/** What a worktree's own space is called. */
const spaceName = (p, w) => (w.main ? p.name : `${p.name} · ${w.branch ?? base(w.path)}`);

/** Starts (or shows) a worktree's coordinator: in `space`, else (`fresh`) in a new space Herdr makes around it,
 *  so its first tab is the coordinator, not a shell, else wherever hcoord puts it. `noFocus`: hcoord leaves the
 *  focus alone and the result's `terminal` is the coordinator's, for the caller to focus (once) itself. */
async function openLane(p, w, { space = null, fresh = false, restart = false, noFocus = false } = {}) {
  const args = ["lane", "open", w.path];
  if (space) args.push("--space", space);
  else if (fresh) args.push("--new-space", spaceName(p, w));
  if (restart) args.push("--restart");
  if (noFocus) args.push("--no-focus", "--json");
  const r = await hcoord(args);
  if (!noFocus) return r;
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {}
  return { ...r, terminal: out?.terminal ?? null, text: out?.lines ? out.lines.join("\n") : r.text };
}

export default class Projects extends View {
  init(_props, cx) {
    if (props()?.log) return this.initLog(cx);
    if (props()?.menu) return this.initMenu(cx);
    if (props()?.ask) return this.initAsk(cx);
    if (props()?.info) return this.initInfo(cx);
    if (props()?.newWorktree) return this.initNew(cx);
    if (props()?.gitInit) return this.initGitInit(cx);
    if (props()?.settings) return this.initSettings(cx);
    this.data = null; // hcoord board --json
    this.error = null;
    this.notSetUp = !HCOORD; // the CLI can't be run: the section says how to set it up
    this.triedAt = 0; // when it last couldn't be
    this.loading = false;
    this.again = false;
    this.syncing = false;
    this.syncAgain = false;
    this.signature = null; // the agents' terminals at the last sync
    this.open = load("open", {}); // "p:<slug>" / "w:<path>" -> shown open (a click); else a default
    this.mergedOpen = new Set(); // worktree paths whose Merged group is open
    this.tried = {}; // worktree path -> when its coordinator was last started by itself
    this.busy = new Set(); // worktree paths being opened
    this.bringing = new Set(); // project slugs whose stopped coordinators are coming back
    this.space = focused()?.space ?? null;
    this.opened = null; // the space Herdr came up on, if it arrived after this copy did: not one the person went to
    this.pendingSpace = null; // the focused space, when it wasn't a known worktree yet: looked at again after each refresh
    this.seenSpaces = new Set(spaces().map((s) => s.id));
    this.born = {}; // space -> when this copy first saw it
    this.dismissed = new Set(load("dismissed", []));
    this.order = load("order", []); // project slugs in the order the person dragged them to
    this.drag = null; // { from, over }: a project header pressed, and the project it's over
    this.offer = null; // { repo } the last "make it a project?" toast is about
    this.removals = load("removals", {}); // removalKey -> { project, path, branch } waiting for a cleanup task
    this.refresh(cx);
    cx.timer.every(SIDEBAR_FALLBACK_MS, (cx) => this.refresh(cx));
    // New spaces settle (their first terminal's folder) for a moment before they're asked about.
    cx.timer.every(1500, (cx) => this.lookAtNewSpaces(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "new") await this.newProject(cx);
        if (c === "adopt" && this.offer) await this.adopt(this.offer.repo, cx);
        if (c === "raise-pr") await this.raisePrFromMenu(cx);
        if (c === "project-made") await this.projectMadeInDialog(cx);
        cx.notify();
      }
    });
  }

  // ------------------------------------------------------------- data

  refresh(cx) {
    // With nothing to run, installing the CLI rewrites hcoord-path.js and that reloads this mod.
    if (!HCOORD || (this.notSetUp && Date.now() - this.triedAt < SETUP_RETRY_MS)) return;
    if (this.loading) {
      this.again = true;
      return;
    }
    this.loading = true;
    cx.spawn(async (cx) => {
      do {
        this.again = false;
        try {
          const r = await hcoord(["board", "--json"]);
          this.notSetUp = r.unavailable;
          if (r.unavailable) {
            this.triedAt = Date.now();
            this.error = null;
          } else {
            if (!r.ok) throw new Error(r.text || "hcoord board failed");
            this.data = JSON.parse(r.stdout);
            this.error = null;
            this.noticeRemovals();
            if (!this.watching) this.watch(cx);
          }
        } catch (e) {
          this.error = String(e?.message ?? e);
        }
        this.retryPendingSpace(cx);
        cx.notify();
      } while (this.again);
      this.loading = false;
    });
  }

  /** hcoord removes a worktree whose cleanup is merged, with nothing here running: once it's off the board, its
   *  spaces close as a direct delete's do. A removal called off leaves the worktree, and a deleted project its folders. */
  noticeRemovals() {
    const now = {};
    for (const p of this.data.projects) {
      for (const l of p.lanes) {
        if (l.removing) now[removalKey(p.slug, l.removing.task)] = { project: p.slug, path: l.path, branch: l.branch ?? base(l.path) };
      }
    }
    const before = this.removals;
    this.removals = now;
    if (JSON.stringify(now) !== JSON.stringify(before)) save("removals", now);
    for (const [key, r] of Object.entries(before)) {
      if (now[key]) continue;
      const p = this.data.projects.find((x) => x.slug === r.project);
      if (!p || p.lanes.some((l) => l.path === r.path) || p.checkouts.some((c) => c.path === r.path)) continue;
      if (!claimRemoval(key)) continue;
      for (const s of this.spacesIn([r.path])) run("space.close", { id: s.id, confirmed: true });
      notify({ title: `Worktree ${r.branch} deleted`, level: "info", timeout: 8000 });
    }
  }

  watch(cx) {
    const dir = `${this.data.root}/projects`;
    this.watching = true;
    cx.spawn(async (cx) => {
      for (;;) {
        try {
          await watchFolder(dir);
        } catch {
          // Not there yet (no project made): the fallback timer refreshes and tries again.
          this.watching = false;
          return;
        }
        this.refresh(cx);
      }
    });
  }

  /** Workers' and coordinators' terminals: when any changes, hcoord checks its workers. */
  maybeSync(all, cx) {
    if (!this.data) return;
    const watched = new Set();
    for (const p of this.data.projects) {
      for (const l of p.lanes) if (l.coordinator) watched.add(l.coordinator.address);
      for (const t of p.tasks) if (t.terminal && ACTIVE.includes(t.state)) watched.add(t.terminal);
    }
    const sig = all
      .filter((t) => watched.has(t.address))
      .map((t) => `${t.address}:${t.state}:${t.status ?? ""}:${t.turn ?? ""}`)
      .sort()
      .join(" ");
    if (sig === this.signature) return;
    const first = this.signature === null;
    this.signature = sig;
    if (first) return;
    if (this.syncing) {
      this.syncAgain = true;
      return;
    }
    this.syncing = true;
    cx.spawn(async (cx) => {
      do {
        this.syncAgain = false;
        await hcoord(["sync"]);
      } while (this.syncAgain);
      this.syncing = false;
      this.refresh(cx);
    });
  }

  // ------------------------------------------------------------- spaces, projects, worktrees

  /** Where a space is: its first terminal's live folder, else the folder it was made in. */
  placeOf(s, ps) {
    const tabs = new Set((s.tabs ?? []).map((c) => c.id));
    return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
  }

  /** A project's worktrees: every checkout git knows, plus registered ones that are gone but still have work,
   *  plus the default branch when nothing has it checked out (`virtual`: clicking it makes the checkout). */
  worktrees(p) {
    const list = p.checkouts.map((c) => {
      const lane = p.lanes.find((l) => l.path === c.path) ?? null;
      return { path: c.path, branch: c.branch ?? lane?.branch ?? null, lane, main: c.path === p.repo };
    });
    for (const l of p.lanes) {
      if (list.some((w) => w.path === l.path)) continue;
      if (p.tasks.some((t) => t.lane === l.key && ACTIVE.includes(t.state))) list.push({ path: l.path, branch: l.branch, lane: l, main: false, gone: !l.present });
    }
    const def = p.defaultBranch;
    if (def && !def.checkedOut && !list.some((w) => w.branch === def.name || w.path === def.path)) {
      list.push({ path: def.path, branch: def.name, lane: null, main: false, virtual: true });
    }
    // The default branch first (wherever it is: the main checkout, another worktree, or `virtual`),
    // then the main checkout when it's on some other branch, then the rest by name.
    // (Only the order on screen: the rail and `go` find the main checkout by `w.main`, not position.)
    const rank = (w) => (def && w.branch === def.name ? 0 : w.main ? 1 : 2);
    return list.sort((a, b) => rank(a) - rank(b) || (a.branch ?? a.path).localeCompare(b.branch ?? b.path));
  }

  /** The project and worktree a folder is in (the deepest checkout containing it). */
  worktreeAt(path) {
    if (!this.data || !path || within(path, this.data.worktreeRoot)) return null;
    let best = null;
    for (const p of this.data.projects) {
      for (const w of this.worktrees(p)) {
        if (within(path, w.path) && (!best || w.path.length > best.w.path.length)) best = { p, w };
      }
    }
    return best;
  }

  /** The space showing a worktree: the one holding its coordinator, else one whose folder is in it. */
  spaceOf(w, ps, ags) {
    const c = w.lane?.coordinator;
    const holder = c && ags.find((a) => a.address === c.address);
    if (holder) return spaces().find((s) => s.id === holder.space) ?? null;
    // A coordinator that's now a shell reports no agent, but its pane is still where it was.
    const pane = c && ps.find((x) => x.terminal === c.address);
    const shown = pane && spaces().find((s) => (s.tabs ?? []).some((x) => x.id === pane.tab));
    if (shown) return shown;
    return spaces().find((s) => !s.machine && this.worktreeAt(this.placeOf(s, ps))?.w.path === w.path) ?? null;
  }

  coordinatorOf(w, all, ags) {
    const c = w.lane?.coordinator;
    if (!c) return { live: false };
    const state = w.lane.coordinatorState ?? null;
    const t = all.find((x) => x.address === c.address && x.name === c.name && x.state === "live");
    // Replaced: the terminal lives on but the coordinator doesn't, even if Herdr reports an agent there
    // (a Claude started by hand in that shell isn't it).
    if (!t || state === "shell" || state === "occupied") return { live: false, address: c.address, session: c.session, state, program: w.lane.coordinatorProgram ?? null };
    const a = ags.find((x) => x.address === t.address);
    return { live: true, address: t.address, status: a?.status ?? null, agent: a ?? null, session: c.session, state };
  }

  /** A worktree on some branch other than the default one, on disk: it can have a pull request. */
  canRaisePr(p, w) {
    return !w.virtual && !w.gone && !!w.branch && !!p.defaultBranch?.name && w.branch !== p.defaultBranch.name;
  }

  /** "Raise PR": the request the person would type to the worktree's coordinator (its skill says how). */
  raisePr(p, w, cx) {
    const say = `Raise a PR for this worktree's branch (${w.branch}) against ${p.defaultBranch.name}.`;
    return this.go(p, w, cx, { say });
  }

  /** The right-click menu (another copy of this mod) leaves which worktree in shared state, then sends "raise-pr". */
  async raisePrFromMenu(cx) {
    const ask = shared("hcoord.raise-pr");
    if (!ask?.path) return;
    setShared("hcoord.raise-pr", null); // taken: a second Projects copy finds nothing
    const p = this.data?.projects.find((x) => x.slug === ask.project);
    const w = p && this.worktrees(p).find((x) => x.path === ask.path);
    if (w && this.canRaisePr(p, w)) await this.raisePr(p, w, cx);
  }

  /** Go to a worktree: its coordinator if it runs, else its space and a new (or resumed) coordinator there.
   *  Something else running in the coordinator's terminal isn't ours to stop: that's only shown.
   *  With `say`, that text is then typed to the coordinator (`hcoord lane say`, which waits for a new one to be up). */
  async go(p, w, cx, { auto = false, space = null, restart = false, say = null } = {}) {
    if (w.virtual) {
      // The default branch isn't checked out anywhere: make its worktree (where Herdr would), then go there.
      if (auto || this.busy.has(w.path)) return;
      this.busy.add(w.path);
      cx.notify();
      const m = await makeCheckout(["lane", "checkout", w.branch, p.slug]);
      this.busy.delete(w.path);
      if (m.error) {
        notify({ title: `Couldn't check out ${w.branch}`, body: m.error, level: "error", timeout: 12000 });
        this.refresh(cx);
        return;
      }
      w = m.w;
    }
    const ags = agents();
    const c = this.coordinatorOf(w, terminals(), ags);
    if (c.state === "occupied" && !say) {
      if (!auto) run("terminal.peek", { terminal: c.address });
      return;
    }
    if (c.live && c.agent && !restart) {
      if (!auto) run("agent.focus", { terminal: c.address });
      if (!say) return;
    }
    if (this.busy.has(w.path)) return;
    const s = space ? spaces().find((x) => x.id === space) ?? { id: space } : this.spaceOf(w, panes(), ags);
    const live = c.live && c.agent;
    const at = spaces().findIndex((x) => x.id === s?.id);
    // No space yet: Herdr makes one around the coordinator (space.new would show a shell first).
    if (!auto && s && !(live && say)) run("space.select", { id: s.id });
    this.busy.add(w.path);
    cx.notify();
    let r;
    if (say) {
      const args = ["lane", "say", w.path, say];
      if (s) args.push("--space", s.id);
      else if (!live) args.push("--new-space", spaceName(p, w));
      r = await hcoord(args);
    } else {
      r = await openLane(p, w, { space: s?.id, fresh: !auto, restart });
    }
    this.busy.delete(w.path);
    this.keepPlace(s, at);
    if (!r.ok) notify({ title: `Couldn't ${say ? "ask" : "open"} ${spaceName(p, w)}${say ? "'s coordinator" : ""}`, body: r.text, level: "error", timeout: 12000 });
    else if (say) notify({ title: `Asked ${w.branch ?? base(w.path)}'s coordinator`, body: say, level: "info", timeout: 6000 });
    this.refresh(cx);
  }

  /** The worktrees of a project whose coordinators a restart stopped, in the order they show. */
  stoppedIn(p, all, ags) {
    return this.worktrees(p).filter((w) => !w.gone && this.coordinatorOf(w, all, ags).state === "shell");
  }

  /** Replacing the only tab in a space closes the space, and Herdr makes it again, unnamed and last, around the new terminal. */
  keepPlace(s, at) {
    const list = spaces();
    const now = list.findIndex((x) => x.id === s?.id);
    if (now < 0) return;
    if (s.named && !list[now].named) run("space.rename", { id: s.id, name: s.name });
    if (at >= 0 && now !== at) run("space.move", { id: s.id, index: at + 1 });
  }

  /** Resumes coordinators one at a time, leaving the focus where it is: hcoord doesn't focus each, and no space is
   *  selected. The one space it has to act on is the person's own, if that closes as above: they're put back. */
  async bringBack(p, list, cx) {
    if (this.bringing.has(p.slug)) return;
    this.bringing.add(p.slug);
    cx.notify();
    for (const w of list) {
      if (this.busy.has(w.path)) continue;
      this.busy.add(w.path);
      cx.notify();
      const s = this.spaceOf(w, panes(), agents());
      const here = !!s && focused()?.space === s.id;
      const at = spaces().findIndex((x) => x.id === s?.id);
      const r = await openLane(p, w, { space: s?.id, fresh: true, noFocus: true });
      if (here && r.terminal && focused()?.space !== s.id) run("agent.focus", { terminal: r.terminal });
      this.busy.delete(w.path);
      this.keepPlace(s, at);
      if (!r.ok) notify({ title: `Couldn't bring back ${spaceName(p, w)}`, body: r.text, level: "error", timeout: 12000 });
      this.refresh(cx);
    }
    this.bringing.delete(p.slug);
    cx.notify();
  }

  /** Switching to a project's worktree space starts its coordinator when it isn't running (once a minute at most).
   *  Herdr coming up isn't a switch: each resume uses a Claude turn, so that waits for the person. Nor is the focus
   *  landing elsewhere while a coordinator is replaced, which can close its space for a moment. */
  followSpace(cx) {
    const now = focused()?.space ?? null;
    if (now === this.space) return;
    this.opened = this.space === null ? now : null;
    this.space = now;
    this.pendingSpace = null;
    if (this.busy.size) return;
    this.startFor(now, cx);
  }

  /** After a refresh: the focused space that wasn't a known worktree may be one now (a worktree just made). */
  retryPendingSpace(cx) {
    const s = this.pendingSpace;
    if (!s) return;
    if (s !== this.space || s !== (focused()?.space ?? null)) {
      this.pendingSpace = null;
      return;
    }
    this.startFor(s, cx);
  }

  /** Starts or resumes the coordinator of the worktree a space is in, if it isn't running. A space that isn't in a
   *  known worktree (yet) stays pending, and is looked at again after the next refresh. */
  startFor(now, cx) {
    if (!now) return;
    const s = spaces().find((x) => x.id === now);
    if (!s || s.machine) return;
    const hit = this.data ? this.worktreeAt(this.placeOf(s, panes())) : null;
    if (!hit) {
      this.pendingSpace = now;
      return;
    }
    this.pendingSpace = null;
    if (hit.w.gone) return;
    if (now === this.opened) return;
    const c = this.coordinatorOf(hit.w, terminals(), agents());
    if (c.live || c.state === "occupied") return;
    if (Date.now() - (this.tried[hit.w.path] ?? 0) < RETRY_MS) return;
    this.tried[hit.w.path] = Date.now();
    cx.spawn(async (cx) => this.go(hit.p, hit.w, cx, { auto: true, space: now }));
  }

  newWorktree(p) {
    openNewWorktree({ project: p.slug, name: p.name, defaultBranch: p.defaultBranch?.name ?? null });
  }

  menuFor(target) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "hcoord", kind: "popup", width: 210, height: 160, props: { menu: target } });
  }

  openLog(args) {
    run("pane.split", { direction: "right", mod: "hcoord", props: { log: args } });
  }

  // ------------------------------------------------------------- new projects

  async newProject(cx) {
    if (this.notSetUp) return;
    const folder = await pickFolder({ prompt: "Make project" });
    if (!folder) return;
    await this.adopt(folder, cx);
  }

  /** Makes a project of a folder's repo, unless one has it, then goes to that checkout. A folder in no repo
   *  gets the dialog offering to make it one; nothing is committed unless the person says so there. */
  async adopt(folder, cx) {
    this.offer = null;
    const known = this.worktreeAt(folder);
    if (known) return this.go(known.p, known.w, cx);
    const name = base(folder);
    const r = await hcoord(["project", "new", name, "--repo", folder, "--json"]);
    if (r.ok) return this.projectMade(r, folder, name, cx);
    let why = r.text;
    if (r.text.includes("not a git repository")) {
      const d = await hcoord(["project", "new", name, "--repo", folder, "--git-init", "--dry-run", "--json"]);
      const plan = d.ok ? parsed(d.stdout) : null;
      if (plan?.gitInit) {
        openOverlay({ mod: "hcoord", kind: "dialog", width: 520, height: 460, props: { gitInit: { name, folder, plan } } });
        return;
      }
      if (!d.ok) why = d.text; // it can't be set up either (a name in use, no git identity): that's the reason to show
    }
    notify({ title: `Couldn't make ${name} a project`, body: why, level: "error", timeout: 12000 });
  }

  /** `project new` worked, `r` being its result: says if Claude needs to trust the repo, then shows the project
   *  and starts the coordinator of the checkout that was picked. */
  async projectMade(r, folder, name, cx) {
    const warning = r.text.split("\n").find((l) => l.startsWith("warning:"));
    if (warning) notify({ title: `${name}: Claude doesn't trust this repo yet`, body: warning.replace(/^warning:\s*/, ""), level: "warning", timeout: 15000 });
    const slug = parsed(r.stdout)?.slug;
    if (slug) {
      this.open[`p:${slug}`] = true;
      save("open", this.open);
    }
    // Open the checkout that was picked (a worktree or the main one).
    const lr = await hcoord(["lane", "open", folder]);
    if (!lr.ok) notify({ title: `Couldn't start ${name}'s coordinator`, body: lr.text, level: "error", timeout: 12000 });
    this.refresh(cx);
  }

  /** The git-init dialog (another copy of this mod) leaves its result in shared state, then sends "project-made":
   *  what's open in the list and the refresh belong to the sidebar copy. */
  async projectMadeInDialog(cx) {
    const made = shared("hcoord.project-made");
    if (!made?.folder) return;
    setShared("hcoord.project-made", null); // taken: a second Projects copy finds nothing
    await this.projectMade(made, made.folder, made.name, cx);
  }

  /** A space made in a git repo no project has: offer to make it one, once per repo. */
  lookAtNewSpaces(cx) {
    if (!this.data) return;
    const ps = panes();
    const now = Date.now();
    for (const s of spaces()) {
      if (this.seenSpaces.has(s.id)) continue;
      const age = now - (this.born[s.id] ??= now);
      const at = this.placeOf(s, ps);
      if (age < 2000 || (!at && age < 6000)) continue;
      this.seenSpaces.add(s.id);
      delete this.born[s.id];
      if (s.machine || !at || at === home() || within(at, this.data.root) || within(at, this.data.worktreeRoot)) continue;
      if (this.worktreeAt(at)) continue; // a project's checkout: followSpace handles it
      cx.spawn(async (cx) => {
        const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: at }).catch(() => null);
        if (!r || r.code !== 0) return;
        const common = r.stdout.trim();
        if (!common.endsWith("/.git")) return;
        const repo = common.slice(0, -5);
        // A known project's repo but no known checkout: a new worktree (Herdr's New worktree dialog, or a
        // space opened on one). Load it now rather than at the fallback timer; followSpace then catches up.
        if (this.data.projects.some((p) => p.repo === repo)) return this.refresh(cx);
        if (this.dismissed.has(repo)) return;
        this.offer = { repo: at };
        this.dismissed.add(repo); // asked once; the folder button still makes it a project later
        save("dismissed", [...this.dismissed]);
        notify({
          title: `Make ${base(repo)} a project?`,
          body: `A coordinator agent for ${tilde(repo)} and its worktrees: click to set it up.`,
          level: "info",
          timeout: 15000,
          action: { name: "hcoord.adopt" },
        });
        cx.notify();
      });
    }
  }

  // ------------------------------------------------------------- drawing

  pill(t, text, color) {
    return div().flex_none().px(6).h(18).rounded(5).bg(color + "26").text_size(10.5).font_semibold().text_color(color).flex().items_center().child(text);
  }

  badge(t, text, color) {
    return div().min_w(14).h(14).px(3).flex_none().rounded(4).bg(color + "26").text_size(10.5).font_bold().text_color(color).flex().items_center().justify_center().child(text);
  }

  status(t, c, busy) {
    if (busy) return svg(ICON("spinner")).size(12).mx(1).flex_none().text_color(t.dim).spin(900);
    if (c.state === "shell") return svg(ICON("square")).size(12).mx(1).flex_none().text_color(t.unknown);
    if (c.state === "occupied") return svg(ICON("terminal")).size(12).mx(1).flex_none().text_color(t.unknown);
    if (!c.live) return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.dim + "80");
    if (c.status === "working") return svg(ICON("spinner")).size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (c.status === "blocked") return this.pill(t, "Needs you", t.blocked);
    if (c.status === "done") return div().size(7).mx(3).flex_none().rounded(4).bg(t.done);
    if (c.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    // Running, no agent status: at a prompt.
    return this.badge(t, "?", t.unknown);
  }

  taskMark(t, task) {
    switch (task.state) {
      case "needs_you":
        return this.badge(t, "!", t.blocked);
      case "starting":
      case "working":
        return svg(ICON("spinner")).size(12).mx(1).flex_none().text_color(t.working).spin(900);
      case "failed":
        return svg(ICON("x")).size(12).mx(1).flex_none().text_color(t.blocked);
      case "done":
        return svg(ICON("git-compare")).size(12).mx(1).flex_none().text_color(t.blocked);
      case "merged":
        return svg(ICON("check")).size(12).mx(1).flex_none().text_color(t.done);
      case "cancelled":
        return svg(ICON("minus")).size(12).mx(1).flex_none().text_color(t.dim);
      case "queued":
        return svg(ICON("clock")).size(12).mx(1).flex_none().text_color(t.dim);
      default:
        return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.dim);
    }
  }

  iconButton(id, t, icon, tip, onClick) {
    return div()
      .id(id)
      .size(18)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(4)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((el) => el.bg(t.hover).text_color(t.foreground))
      .tooltip(tip)
      // Pressing a button in a project's header isn't the start of dragging the project.
      .on_mouse_down("left", (e) => { this.buttonPress = e.position; })
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onClick(cx);
      })
      .child(svg(ICON(icon)).size(12));
  }

  taskRow(t, p, task, all) {
    const live = !!task.terminal && ACTIVE.includes(task.state) && all.some((x) => x.address === task.terminal && x.state === "live");
    const note =
      task.state === "needs_you" ? plain(task.reason)
      : task.state === "done" ? (task.mergeError ? `not merged: ${task.mergeError}` : "merging…")
      : task.state === "failed" ? plain(task.summary)
      : task.state === "merged" ? plain(task.summary)
      : task.state === "queued" && task.waitingOn.length ? `after ${task.waitingOn.join(", ")}`
      : null;
    const quiet = task.state === "merged" || task.state === "cancelled";
    const log = () => this.openLog(task.id);
    const tip = [`${task.id} ${task.title}`, live ? "Click: peek at its terminal" : task.hasLog ? "Click: its log" : null].filter(Boolean).join("\n");
    return v_flex()
      .id(`task-${task.id}`)
      .pl(44)
      .pr(6)
      .py(3)
      .flex_none()
      .rounded(8)
      .gap(1)
      .when(live || task.hasLog, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
      .on_click(() => (live ? run("terminal.peek", { terminal: task.terminal }) : task.hasLog ? log() : null))
      .tooltip(tip)
      .child(h_flex().gap(7).items_center()
        .child(this.taskMark(t, task))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(task.id))
        .child(div().flex_1().min_w(0).truncate().text_color(quiet ? t.muted : t.foreground).child(task.title))
        .when(task.hasLog, (el) => el.child(this.iconButton(`log-${task.id}`, t, "file-text", "Its log: what the agent did", log))))
      .when(Boolean(note), (el) => el.child(div().pl(19).truncate().text_size(11.5)
        .text_color(task.state === "needs_you" || task.state === "done" ? t.blocked : t.dim).child(note)));
  }

  groupHeader(t, w, g, n) {
    const folded = g.folded && !this.mergedOpen.has(w.path);
    return h_flex()
      .id(`grp-${w.path}-${g.id}`)
      .pl(44)
      .pr(8)
      .h(20)
      .pt(3)
      .flex_none()
      .gap(6)
      .items_center()
      .text_size(11)
      .font_medium()
      .text_color(t[g.tone] ?? t.dim)
      .when(Boolean(g.folded), (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => {
        folded ? this.mergedOpen.add(w.path) : this.mergedOpen.delete(w.path);
        cx.notify();
      }))
      .child(div().child(g.label))
      .child(div().text_color(t.dim).child(String(n)))
      .when(Boolean(g.folded), (el) => el.child(svg(ICON(folded ? "chevron-right" : "chevron-down")).size(11).flex_none().text_color(t.dim)));
  }

  fold(t, key, isOpen) {
    return div()
      .id(`fold-${key}`)
      .size(16)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(4)
      .text_color(t.dim)
      .hover((el) => el.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.open[key] = !isOpen;
        save("open", this.open);
        cx.notify();
      })
      .child(svg(ICON(isOpen ? "chevron-down" : "chevron-right")).size(11));
  }

  worktreeRows(t, p, w, ctx) {
    const { all, ags, ps, hereSpace } = ctx;
    const c = this.coordinatorOf(w, all, ags);
    const s = this.spaceOf(w, ps, ags);
    const tasks = w.lane ? p.tasks.filter((x) => x.lane === w.lane.key) : [];
    const needs = tasks.filter((x) => x.state === "needs_you" || (x.state === "done" && x.mergeError)).length;
    const working = tasks.filter((x) => x.state === "working" || x.state === "starting").length;
    const here = s && s.id === hereSpace;
    const key = `w:${w.path}`;
    const isOpen = this.open[key] ?? (here || needs > 0 || working > 0);
    const busy = this.busy.has(w.path);
    const label = w.branch ?? base(w.path);
    const stopped = c.state === "shell" && !w.gone;
    const occupied = c.state === "occupied" && !w.gone;
    const bringBackTip = `Stopped by a restart. Click: bring it back, ${c.session ? "carrying on its conversation" : "as a new conversation"}`;
    const { row: occupiedRow, tip: occupiedTip } = occupiedWords(c);

    const head = h_flex()
      .id(`wt-${w.path}`)
      .pl(22)
      .pr(6)
      .h(28)
      .flex_none()
      .rounded(8)
      .items_center()
      .gap(6)
      .when(Boolean(here), (el) => el.bg(t.selected))
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .tooltip(w.virtual
        ? `The default branch, not checked out anywhere.\nClick: check it out in ${tilde(w.path)} and start its coordinator`
        : `${tilde(w.path)}\n${stopped ? bringBackTip : occupied ? occupiedTip : c.live ? "Click: show its coordinator" : w.gone ? "This worktree is gone" : "Click: start its coordinator"}`)
      .on_click((_e, cx) => {
        if (!w.gone) cx.spawn(async (cx) => this.go(p, w, cx));
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        if (w.virtual) return; // nothing on disk yet to act on
        this.menuFor({ kind: "worktree", project: p.slug, name: p.name, path: w.path, branch: label, main: w.main, gone: !!w.gone, log: c.session ? { project: p.slug, lane: w.lane.key } : null, pr: this.canRaisePr(p, w) });
      })
      .child(this.fold(t, key, isOpen))
      .child(svg(ICON(w.main ? "folder" : "git-branch")).size(12).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().text_color(w.gone ? t.dim : c.live || here ? t.foreground : t.muted).child(label))
      .when(!isOpen && working > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.working).child(String(working))))
      .when(!isOpen && needs > 0, (el) => el.child(this.badge(t, String(needs), t.blocked)))
      .when(this.canRaisePr(p, w), (el) => el.child(this.iconButton(`pr-${w.path}`, t, "git-branch", `Raise PR: ask the coordinator to open a pull request for ${w.branch}`, (cx) => cx.spawn(async (cx) => this.raisePr(p, w, cx)))))
      .when(Boolean(c.session), (el) => el.child(this.iconButton(`clog-${w.path}`, t, "file-text", "The coordinator's log", () => this.openLog({ project: p.slug, lane: w.lane.key }))))
      .child(this.status(t, c, busy));

    const rows = [head];
    // A pending removal, a stopped or an occupied coordinator show on a folded worktree too.
    if (w.lane?.removing) {
      const stuck = cleanupStuck(w.lane.removing, tasks.find((x) => x.id === w.lane.removing.task));
      rows.push(h_flex()
        .id(`removing-${w.path}`)
        .pl(44).pr(8).py(3).flex_none().rounded(8).gap(6)
        .tooltip(stuck
          ? "The worktree was kept. Ask its coordinator what went wrong, or right-click: Delete worktree…"
          : "Its coordinator is running the cleanup prompt. The worktree is removed once that finishes.")
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(stuck ? t.blocked : t.dim).child(stuck ? "Cleanup failed" : "Cleaning up…")));
    }
    if (stopped) {
      rows.push(h_flex()
        .id(`stopped-${w.path}`)
        .pl(44).pr(8).py(3).flex_none().rounded(8).gap(6)
        .cursor_pointer()
        .hover((el) => el.bg(t.hover))
        .tooltip(bringBackTip)
        .on_click((_e, cx) => cx.spawn(async (cx) => this.go(p, w, cx)))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.unknown).child("Stopped by a restart: click to bring back")));
    }
    if (occupied) {
      rows.push(h_flex()
        .id(`occupied-${w.path}`)
        .pl(44).pr(8).py(3).flex_none().rounded(8).gap(6)
        .cursor_pointer()
        .hover((el) => el.bg(t.hover))
        .tooltip(occupiedTip)
        .on_click(() => run("terminal.peek", { terminal: c.address }))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.unknown).child(occupiedRow)));
    }
    if (!isOpen) return rows;
    if (c.live && (!c.agent || c.state === "prompt")) {
      rows.push(h_flex()
        .id(`restart-${w.path}`)
        .pl(44).pr(8).py(3).flex_none().rounded(8).gap(6)
        .cursor_pointer()
        .hover((el) => el.bg(t.hover))
        .tooltip("It reports no status: it's waiting at a prompt (Claude's trust question?). Click: show it. The button at the end replaces it with a fresh Claude.")
        .on_click(() => run("terminal.peek", { terminal: c.address }))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.unknown).child("Coordinator reports no status: look at it"))
        .child(this.iconButton(`restartbtn-${w.path}`, t, "square-pen", "Replace it with a fresh Claude, carrying on its conversation", (cx) => cx.spawn(async (cx) => this.go(p, w, cx, { restart: true })))));
    }
    const lost = tasks.filter((x) => x.state === "failed" && /no longer exists/.test(x.summary ?? ""));
    if (lost.length) {
      rows.push(h_flex()
        .id(`recover-${w.path}`)
        .pl(44).pr(8).py(3).flex_none().rounded(8).gap(6)
        .cursor_pointer()
        .hover((el) => el.bg(t.hover))
        .tooltip("Their terminals ended (a reboot?). Click to start them again, each carrying on in its checkout.")
        .on_click((_e, cx) => cx.spawn(async (cx) => {
          for (const x of lost) await hcoord(["task", "retry", x.id]);
          this.refresh(cx);
        }))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.blocked).child(`${lost.length} worker${lost.length > 1 ? "s" : ""} lost: carry on`)));
    }
    if (!tasks.length) {
      rows.push(div().pl(44).pr(8).py(3).text_size(11.5).text_color(t.dim)
        .child(c.live ? "No tasks yet: tell the coordinator what to do."
          : w.virtual ? "Not checked out: click to check it out and start a coordinator."
          : w.lane ? "No tasks yet." : "No coordinator yet: click to start one."));
    }
    for (const g of GROUPS) {
      const members = tasks.filter((x) => g.states.includes(x.state));
      if (!members.length) continue;
      rows.push(this.groupHeader(t, w, g, members.length));
      if (g.folded && !this.mergedOpen.has(w.path)) continue;
      const list = g.folded ? [...members].sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1)) : members;
      for (const task of list) rows.push(this.taskRow(t, p, task, all));
    }
    rows.push(div().h(4).flex_none());
    return rows;
  }

  // ------------------------------------------------------------- order

  // Projects in the person's order: the saved ones first, then any new ones as hcoord lists them.
  // Saved slugs whose project is gone are skipped.
  ordered(projects) {
    const at = new Map(this.order.map((slug, i) => [slug, i]));
    return projects
      .map((p, i) => ({ p, i, o: at.get(p.slug) ?? Infinity }))
      .sort((a, b) => a.o - b.o || a.i - b.i)
      .map((r) => r.p);
  }

  // Dragging a project (its header, or its rail row) onto another: it takes that one's place.
  // The line shows where it lands: under the one it's over when moving down, above when moving up.
  draggable(el, t, p, list) {
    const slugs = list.map((x) => x.slug);
    const i = slugs.indexOf(p.slug);
    const d = this.drag;
    const from = d ? slugs.indexOf(d.from) : -1;
    return el
      .relative()
      .when(!!d && d.from === p.slug && d.over !== p.slug, (el) => el.opacity(0.5))
      .when(!!d && from >= 0 && d.over === p.slug && d.from !== p.slug, (el) => el.child(
        div().absolute().left(0).right(0).h(2).rounded(1).bg(t.accent)
          .when(from < i, (line) => line.bottom(0))
          .when(from > i, (line) => line.top(0))))
      .on_mouse_move((_e, cx) => {
        if (this.drag && this.drag.over !== p.slug) {
          this.drag.over = p.slug;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const d = this.drag;
        this.drag = null;
        if (d && d.from !== p.slug && slugs.includes(d.from)) {
          const next = slugs.filter((s) => s !== d.from);
          next.splice(i, 0, d.from);
          this.order = next;
          save("order", next);
        }
        cx.notify();
      });
  }

  // A press on a project's header (not one of its buttons) that may become a drag.
  // The button's handler runs first and leaves the press's position behind.
  pressProject(p, e) {
    const b = this.buttonPress;
    this.buttonPress = null;
    if (b && b.x === e.position.x && b.y === e.position.y) return;
    this.drag = { from: p.slug, over: p.slug };
  }

  endDrag(cx) {
    if (!this.drag) return;
    this.drag = null;
    cx.notify();
  }

  projectRows(t, p, ctx, list) {
    const wts = this.worktrees(p);
    const needs = p.tasks.filter((x) => x.state === "needs_you" || (x.state === "done" && x.mergeError)).length;
    const hereHit = this.worktreeAt(ctx.herePlace);
    const here = hereHit?.p.slug === p.slug;
    const key = `p:${p.slug}`;
    const stopped = this.stoppedIn(p, ctx.all, ctx.ags);
    const isOpen = this.open[key] ?? (here || needs > 0 || stopped.length > 0 || this.data.projects.length === 1);
    const head = h_flex()
      .id(`proj-${p.slug}`)
      .px(6)
      .h(30)
      .flex_none()
      .rounded(8)
      .items_center()
      .gap(6)
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .tooltip(`${p.name}: ${tilde(p.repo)}`)
      .on_click((_e, cx) => {
        this.open[key] = !isOpen;
        save("open", this.open);
        cx.notify();
      })
      .on_mouse_down("left", (e) => this.pressProject(p, e))
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        this.menuFor({ kind: "project", project: p.slug, name: p.name, repo: p.repo, defaultBranch: p.defaultBranch?.name ?? null });
      })
      .child(this.fold(t, key, isOpen))
      .child(div().flex_1().min_w(0).truncate().font_medium().text_color(here ? t.foreground : t.muted).child(p.name))
      .when(!isOpen && needs > 0, (el) => el.child(this.badge(t, String(needs), t.blocked)))
      .child(this.iconButton(`settings-${p.slug}`, t, "settings", "Project settings", () => openSettings({ project: p.slug, name: p.name })))
      .child(this.iconButton(`newwt-${p.slug}`, t, "plus", "New worktree (with its own coordinator)", () => this.newWorktree(p)));
    const block = (rows) => this.draggable(v_flex().id(`projblock-${p.slug}`).flex_none(), t, p, list).children(rows);
    if (!isOpen) return block([head]);
    const rows = [head];
    if (p.trusted === false) {
      rows.push(h_flex()
        .id(`trust-${p.slug}`)
        .pl(22).pr(8).py(3).flex_none().rounded(8)
        .cursor_pointer()
        .hover((el) => el.bg(t.hover))
        .tooltip(`Claude hasn't been told to trust ${tilde(p.repo)}, so its agents would stop at that prompt. Click to open Claude there and answer it yourself.`)
        .on_click(() => run("tab.new", { name: `trust ${base(p.repo)}`, folder: p.repo, argv: ["claude"] }))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.blocked).child(`Claude doesn't trust ${tilde(p.repo)} yet`)));
    }
    if (stopped.length > 1) {
      const bringing = this.bringing.has(p.slug);
      rows.push(h_flex()
        .id(`bring-back-${p.slug}`)
        .pl(22).pr(8).py(3).flex_none().rounded(8).gap(6)
        .cursor_pointer()
        .hover((el) => el.bg(t.hover))
        .tooltip("A restart stopped them. Click to bring each back in turn, carrying on its conversation. You stay where you are.")
        .on_click((_e, cx) => cx.spawn(async (cx) => this.bringBack(p, stopped, cx)))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.blocked)
          .child(bringing ? "Bringing coordinators back…" : `${stopped.length} coordinators stopped: bring back`)));
    }
    for (const w of wts) rows.push(...this.worktreeRows(t, p, w, ctx));
    return block(rows);
  }

  railRow(t, p, ctx, list) {
    const needs = p.tasks.filter((x) => x.state === "needs_you" || (x.state === "done" && x.mergeError)).length;
    const working = p.tasks.filter((x) => x.state === "working" || x.state === "starting").length;
    const main = this.worktrees(p).find((w) => w.main);
    return this.draggable(h_flex(), t, p, list)
      .id(`rail-${p.slug}`)
      .h(26)
      .px(8)
      .flex_none()
      .items_center()
      .gap(4)
      .hover((s) => s.bg(t.hover))
      .tooltip(p.name)
      .on_click((_e, cx) => {
        if (main) cx.spawn(async (cx) => this.go(p, main, cx));
      })
      .on_mouse_down("left", (e) => this.pressProject(p, e))
      .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_size(11).text_color(t.muted).child(p.prefix))
      .child(h_flex().w(14).flex_none().items_center().justify_center()
        .child(needs ? this.badge(t, String(needs), t.blocked)
          : working ? svg(ICON("spinner")).size(12).flex_none().text_color(t.working).spin(900)
          : div().size(7).flex_none().rounded(4).border(1.5).border_color(t.dim + "80")));
  }

  render(cx) {
    const t = theme();
    if (props()?.log) return this.renderLog(t);
    if (props()?.menu) return this.renderMenu(t);
    if (props()?.ask) return this.renderAsk(t);
    if (props()?.info) return this.renderInfo(t);
    if (props()?.newWorktree) return this.renderNew(t);
    if (props()?.gitInit) return this.renderGitInit(t);
    if (props()?.settings) return this.renderSettings(t);
    const all = terminals();
    const ags = agents();
    const ps = panes();
    this.maybeSync(all, cx);
    this.followSpace(cx);
    const collapsed = narrow();
    const hereSpace = focused()?.space ?? null;
    const hs = spaces().find((s) => s.id === hereSpace);
    const ctx = { all, ags, ps, hereSpace, herePlace: hs ? this.placeOf(hs, ps) : null };
    const projects = this.ordered(this.data?.projects ?? []);

    const plus = div()
      .id("hc-new")
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.text_color(t.foreground))
      .tooltip("New project from a folder")
      .on_click((_e, cx) => cx.spawn(async (cx) => {
        await this.newProject(cx);
        cx.notify();
      }))
      .child(svg(ICON("folder-plus")).size(14));

    const body = collapsed
      ? projects.map((p) => this.railRow(t, p, ctx, projects))
      : projects.map((p) => this.projectRows(t, p, ctx, projects));

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!collapsed, (el) => el.child(h_flex()
        .px(16)
        .h(41)
        .pt(14)
        .pb(5)
        .flex_none()
        .items_center()
        .justify_between()
        .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Projects"))
        .when(!this.notSetUp, (el) => el.child(plus))))
      .when(this.notSetUp && !collapsed, (el) => el.child(this.setupNotice(t)))
      .when(Boolean(this.error) && !collapsed, (el) => el.child(div().px(16).pb(6).text_size(12).text_color(t.blocked).child(`hcoord: ${this.error}`)))
      .when(!collapsed && !!this.data?.warnings?.length, (el) => el.children(this.data.warnings.map((w, i) =>
        h_flex().id(`hc-warn-${i}`).mx(8).px(8).mb(6).h(24).flex_none().gap(6).items_center().rounded(6)
          .text_size(12).text_color(t.blocked)
          .cursor_pointer()
          .hover((el) => el.bg(t.hover))
          .tooltip("Click for more")
          .on_click(() => openOverlay({ mod: "hcoord", kind: "dialog", width: 520, height: 400, props: { info: { warning: w, root: this.data.root, worktreeRoot: this.data.worktreeRoot } } }))
          .child(div().flex_1().min_w(0).truncate().child(/temporary folder/.test(w) ? "Data folder is temporary: it may be emptied" : w))
          .child(svg(ICON("chevron-right")).size(11).flex_none()))))
      .when(!this.error && !!this.data && !projects.length && !collapsed, (el) => el.child(
        div().px(16).text_size(12).text_color(t.dim).child("No projects yet. The folder button makes one from any folder, and offers to set up git if it needs it; each of its worktrees gets a coordinator agent you talk to.")))
      .child(v_flex().id("hc-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("always")
        // A drag let go off the projects, or taken out of the list, is dropped.
        .on_mouse_up("left", (_e, cx) => this.endDrag(cx))
        .on_hover((hovered, cx) => { if (!hovered) this.endDrag(cx); })
        .children(body))
      .when(collapsed, (el) => el.child(h_flex().h(28).items_center().justify_center().child(this.notSetUp ? this.setupRail(t) : plus)));
  }

  /** The CLI can't be run: what's needed, in the section itself. */
  setupNotice(t) {
    return v_flex().px(16).pb(8).gap(6).flex_none().text_size(12).text_color(t.dim)
      .child(div().child("Projects needs hcoord's CLI. Install it, then run hcoord mod install."))
      .child(div()
        .id("hc-setup")
        .text_color(t.muted)
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .tooltip("Open the install steps")
        .on_click((_e, cx) => cx.open_url(SETUP_URL))
        .child(SETUP_URL));
  }

  /** The same on the sidebar's narrow rail. */
  setupRail(t) {
    return div()
      .id("hc-setup")
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.text_color(t.foreground))
      .tooltip(`Projects needs hcoord's CLI: ${SETUP_URL}`)
      .on_click((_e, cx) => cx.open_url(SETUP_URL))
      .child(svg(ICON("minus")).size(14));
  }

  // ------------------------------------------------------------- a log pane

  initLog(cx) {
    this.md = "Loading…";
    this.transcript = null;
    this.loadLog(cx);
    cx.timer.every(FALLBACK_MS, (cx) => this.loadLog(cx));
  }

  logArgs() {
    const l = props().log;
    return typeof l === "string" ? ["log", l, "--json"] : ["log", "--lane", l.lane, l.project, "--json"];
  }

  loadLog(cx) {
    if (this.logLoading) return;
    this.logLoading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await hcoord(this.logArgs());
        if (!r.ok) throw new Error(r.text);
        const j = JSON.parse(r.stdout);
        this.md = j.markdown;
        if (j.transcript && j.transcript !== this.transcript) {
          this.transcript = j.transcript;
          this.followTranscript(cx, j.transcript);
        }
      } catch (e) {
        this.md = `Couldn't read the log: ${e?.message ?? e}`;
      }
      this.logLoading = false;
      cx.notify();
    });
  }

  /** The transcript grows as the agent works: reload when its folder changes. */
  followTranscript(cx, file) {
    const dir = file.slice(0, file.lastIndexOf("/"));
    cx.spawn(async (cx) => {
      for (;;) {
        try {
          const changed = await watchFolder(dir);
          if (changed.some((c) => c === file || c === dir)) this.loadLog(cx);
        } catch {
          return;
        }
      }
    });
  }

  renderLog(t) {
    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.background)
      .child(TextView.markdown("hc-log", this.md ?? "").selectable(true).scrollable(true).flex_1().min_h(0).px(18).py(12).text_size(13));
  }

  // ------------------------------------------------------------- a right-click menu

  initMenu(cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  menuItems() {
    const m = props().menu;
    if (m.kind === "project") {
      return [
        { label: "New worktree", icon: "git-branch", go: () => openNewWorktree({ project: m.project, name: m.name, defaultBranch: m.defaultBranch ?? null }) },
        { label: "Delete project…", icon: "x", danger: true, go: () => openOverlay({ mod: "hcoord", kind: "dialog", width: 480, height: 360, props: { ask: { ...m, what: "project" } } }) },
      ];
    }
    const items = [];
    if (m.pr) items.push({ label: "Raise PR", icon: "git-branch", go: () => {
      setShared("hcoord.raise-pr", { project: m.project, path: m.path });
      run("hcoord.raise-pr");
    } });
    if (m.log) items.push({ label: "Coordinator's log", icon: "file-text", go: () => run("pane.split", { direction: "right", mod: "hcoord", props: { log: m.log } }) });
    if (m.main) items.push({ label: "Main checkout: delete the project instead", icon: "folder", disabled: true });
    else items.push({ label: "Delete worktree…", icon: "x", danger: true, go: () => openOverlay({ mod: "hcoord", kind: "dialog", width: 460, height: 360, props: { ask: { ...m, what: "worktree" } } }) });
    return items;
  }

  choose(i) {
    const it = this.menuItems()[i];
    if (!it || it.disabled) return;
    closeOverlay(props().overlay);
    it.go();
  }

  renderMenu(t) {
    const list = this.menuItems();
    return v_flex()
      .id("hc-menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(list.map((it, i) =>
        v_flex()
          .when(i > 0 && !!it.danger, (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
          .child(h_flex()
            .id(`hm-${i}`)
            .h(31)
            .px(8)
            .gap(9)
            .rounded(7)
            .items_center()
            .text_color(it.disabled ? t.dim : it.danger ? t.blocked : t.foreground)
            .when(i === this.at && !it.disabled, (el) => el.bg(t.selected))
            .when(!it.disabled, (el) => el.hover((s) => s.bg(t.hover)).on_click(() => this.choose(i)))
            .child(svg(ICON(it.icon)).size(14).flex_none().text_color(it.danger ? t.blocked : t.muted))
            .child(div().flex_1().min_w(0).truncate().child(it.label)))));
  }

  // ------------------------------------------------------------- asking before a delete

  initAsk(cx) {
    this.plan = null;
    this.error = null;
    this.busyAsk = false;
    this.handle = cx.focus_handle();
    this.handle.focus();
    const a = props().ask;
    const args = a.what === "project" ? ["project", "delete", a.project, "--dry-run", "--json"] : ["lane", "remove", a.path, "--dry-run", "--json"];
    cx.spawn(async (cx) => {
      const r = await hcoord(args);
      if (r.ok) {
        try {
          this.plan = JSON.parse(r.stdout);
        } catch (e) {
          this.error = String(e);
        }
      } else this.error = r.text;
      cx.notify();
    });
  }

  /** Spaces showing a folder in one of these checkouts. */
  spacesIn(paths) {
    const ps = panes();
    return spaces().filter((s) => !s.machine && paths.some((p) => within(this.placeOf(s, ps), p)));
  }

  async doDelete(files, cx, { skipCleanup = false } = {}) {
    const a = props().ask;
    const plan = this.plan;
    if (!plan || this.busyAsk) return;
    this.busyAsk = true;
    this.error = null;
    cx.notify();
    let args, closing = [], deferred = false, claimed = null;
    if (a.what === "project") {
      args = ["project", "delete", a.project, ...(files ? ["--files"] : [])];
      // Its folders are about to go: their spaces first, so no shell sits in them.
      if (files) closing = this.spacesIn(plan.checkouts.map((c) => c.path));
    } else {
      // A deferred removal needs its coordinator, which lives in those spaces: see noticeRemovals.
      deferred = !!plan.cleanupPrompt && !skipCleanup;
      args = ["lane", "remove", plan.path, ...(plan.changed.length ? ["--force"] : []), ...(skipCleanup ? ["--skip-cleanup"] : []), ...(deferred ? ["--json"] : [])];
      if (!deferred) closing = this.spacesIn([plan.path]);
      // Ending a pending removal here: the toast below says so, not the sidebar seeing it go.
      if (plan.removing) {
        claimed = removalKey(plan.project, plan.removing.task);
        claimRemoval(claimed);
      }
    }
    for (const s of closing) run("space.close", { id: s.id, confirmed: true });
    const r = await hcoord(args);
    const answer = deferred ? parsed(r.stdout) : null;
    const text = answer?.lines?.join("\n") ?? r.text;
    const waiting = !!answer?.cleanup;
    if (claimed && (waiting || !r.ok)) releaseRemoval(claimed);
    this.busyAsk = false;
    if (!r.ok) {
      this.error = text;
      cx.notify();
      return;
    }
    // Asked to wait, but it's gone: the cleanup had merged already, or the prompt has been cleared since.
    if (deferred && !waiting) for (const s of this.spacesIn([plan.path])) run("space.close", { id: s.id, confirmed: true });
    closeOverlay(props().overlay);
    const body = text.split("\n").slice(-3).join("\n");
    if (waiting) {
      notify({ title: `Cleanup started for ${a.branch}`, body, level: "info", timeout: 8000 });
      return;
    }
    const what = a.what === "project" ? `${a.name} deleted${files ? ", files too" : " from Herdr"}` : `Worktree ${a.branch} deleted`;
    notify({ title: what, body, level: "info", timeout: 8000 });
  }

  askLines(t) {
    const a = props().ask;
    const p = this.plan;
    const line = (text, color = t.muted) => div().text_color(color).child(text);
    const out = [];
    if (!p) return [line(this.error ? "" : "Looking…", t.dim)];
    if (a.what === "worktree") {
      out.push(line(`${tilde(p.path)} goes, with its Herdr space. The branch ${p.branch ?? "(detached)"} is kept.`));
      if (p.cleanupPrompt) {
        out.push(line(p.removing
          ? `Its cleanup ${p.removing.task} hasn't finished. Delete worktree picks it up again if it stopped; Delete without cleanup removes the worktree now.`
          : "The coordinator runs the cleanup prompt first, and the worktree is removed once that finishes."));
        out.push(line(p.cleanupPrompt.split("\n")[0], t.dim));
      }
      if (p.changed.length) out.push(line(`It has ${p.changed.length} uncommitted file${p.changed.length > 1 ? "s" : ""}: they will be lost (${p.changed.slice(0, 4).join(", ")}${p.changed.length > 4 ? ", …" : ""}).`, t.blocked));
      if (p.coordinator) out.push(line("Its coordinator is stopped."));
      if (p.unfinished.length) out.push(line(`Unfinished tasks are cancelled and their workers stopped: ${p.unfinished.join(", ")}.`, t.blocked));
      return out;
    }
    const n = p.coordinators.length;
    out.push(div().text_color(t.foreground).font_medium().child("Remove from Herdr"));
    out.push(line(`Stops ${n ? `its ${n} coordinator${n > 1 ? "s" : ""}` : "its agents"}${p.unfinished.length ? ` and cancels ${p.unfinished.join(", ")}` : ""}. Its tasks and logs move to ${tilde(p.archive.replace(/\/[^/]+$/, ""))}. The repo and worktrees stay on disk.`));
    out.push(div().h(6));
    out.push(div().text_color(t.blocked).font_medium().child("Delete files too"));
    out.push(line(`Also ${p.trash ? "moves these to the Trash" : "deletes these for good"}, and closes their spaces:`));
    for (const c of p.checkouts) out.push(line(`  ${tilde(c.path)}${c.changed ? ` (${c.changed} uncommitted)` : ""}`, c.changed ? t.blocked : t.muted));
    if (p.workerDir) out.push(line(`  ${tilde(p.workerDir)} (workers' checkouts)`));
    if (p.unpushed) out.push(line(`${p.unpushed} commit${p.unpushed > 1 ? "s aren't" : " isn't"} pushed anywhere: ${p.trash ? "only the Trash will have them" : "they will be lost"}.`, t.blocked));
    return out;
  }

  renderAsk(t) {
    const a = props().ask;
    const ready = !!this.plan && !this.busyAsk;
    const button = (id, label, bg, fg, onClick) =>
      h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1().border_color(id === "no" ? t.input : bg).bg(bg).text_color(fg)
        .when(ready || id === "no", (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick))
        .when(!ready && id !== "no", (el) => el.opacity(0.5))
        .child(label);
    const title = a.what === "project" ? `Delete project ${a.name}?` : `Delete worktree ${a.branch}?`;
    const buttons = [button("no", "Cancel", t.raised, t.foreground, () => closeOverlay(props().overlay))];
    if (a.what === "project") {
      buttons.push(button("herdr", "Remove from Herdr", t.solid, t.solid_foreground, (_e, cx) => cx.spawn(async (cx) => this.doDelete(false, cx))));
      buttons.push(button("files", "Delete files too", t.blocked, "#ffffff", (_e, cx) => cx.spawn(async (cx) => this.doDelete(true, cx))));
    } else {
      if (this.plan?.cleanupPrompt) buttons.push(button("skip", "Delete without cleanup", t.solid, t.solid_foreground, (_e, cx) => cx.spawn(async (cx) => this.doDelete(false, cx, { skipCleanup: true }))));
      buttons.push(button("yes", "Delete worktree", t.blocked, "#ffffff", (_e, cx) => cx.spawn(async (cx) => this.doDelete(false, cx))));
    }
    return v_flex()
      .id("hc-ask")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        closeOverlay(props().overlay);
        cx.stop_propagation();
      })
      .size_full()
      .min_h(0)
      .p(18)
      .gap(12)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().text_color(t.foreground).child(title))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(v_flex().id("hc-ask-body").flex_1().min_h(0).gap(4).overflow_y_scrollbar().children(this.askLines(t))
        .when(Boolean(this.error), (el) => el.child(div().pt(6).text_color(t.blocked).child(this.error))))
      .child(h_flex().justify_end().gap(8).text_size(12)
        .when(this.busyAsk, (el) => el.child(div().flex_1().text_color(t.dim).child("Deleting…")))
        .children(buttons));
  }

  // ------------------------------------------------------------- asking before git init

  initGitInit(cx) {
    this.error = null;
    this.busyGit = false;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  async doGitInit(cx) {
    if (this.busyGit) return;
    const { name, folder } = props().gitInit;
    this.busyGit = true;
    this.error = null;
    cx.notify();
    const r = await hcoord(["project", "new", name, "--repo", folder, "--git-init", "--json"]);
    this.busyGit = false;
    if (!r.ok) {
      this.error = r.text.replace(/^hcoord: /, "") || "hcoord failed";
      cx.notify();
      return;
    }
    setShared("hcoord.project-made", { folder, name, text: r.text, stdout: r.stdout });
    run("hcoord.project-made");
    closeOverlay(props().overlay);
  }

  renderGitInit(t) {
    const { name, folder, plan } = props().gitInit;
    const { files, count, hasGitignore } = plan;
    const busy = this.busyGit;
    // While it runs the commit can't be called back, so Cancel and Esc wait too.
    const close = () => {
      if (!busy) closeOverlay(props().overlay);
    };
    const button = (id, label, bg, fg, onClick) =>
      h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1().border_color(id === "no" ? t.input : bg).bg(bg).text_color(fg)
        .when(!busy, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick))
        .when(busy, (el) => el.opacity(0.5))
        .child(label);
    const hidden = count - files.length;
    return v_flex()
      .id("hc-git")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        close();
        cx.stop_propagation();
      })
      .size_full()
      .min_h(0)
      .p(18)
      .gap(12)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().text_color(t.foreground).child(`Set up git in ${name}?`))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().text_color(t.muted).child(`${tilde(folder)} isn't a git repo yet. Workers each get a checkout of it, and for that it needs a first commit of its files.`))
      .when(count > 0 && !hasGitignore, (el) => el.child(div().text_color(t.blocked)
        .child("There's no .gitignore, so everything listed gets committed, including things like node_modules or .env.")))
      .child(div().text_color(t.foreground).font_medium()
        .child(count ? `${count} file${count > 1 ? "s" : ""} will be committed:` : "The folder has no files to commit, so the first commit will be empty."))
      .child(v_flex().id("hc-git-files").flex_1().min_h(0).overflow_y_scrollbar().text_size(12).text_color(t.muted)
        .children(files.map((f) => div().truncate().child(f)))
        .when(hidden > 0, (el) => el.child(div().pt(4).text_color(t.dim).child(`and ${hidden} more`))))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .child(h_flex().justify_end().gap(8).text_size(12)
        .when(busy, (el) => el.child(div().flex_1().text_color(t.dim).child("Setting up git…")))
        .child(button("no", "Cancel", t.raised, t.foreground, close))
        .child(button("yes", "Set up git", t.solid, t.solid_foreground, (_e, cx) => cx.spawn(async (cx) => this.doGitInit(cx)))));
  }

  // ------------------------------------------------------------- what a warning means

  initInfo(cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  infoText() {
    const i = props().info;
    if (!/temporary folder/.test(i.warning)) return i.warning;
    return [
      "hcoord keeps everything it knows about your projects in one data folder:",
      "",
      "```",
      i.root,
      "```",
      "",
      "It holds each project's tasks, the workers' reports, the coordinators' notes (`PROJECT.md`, `MEMORY.md`) and its settings (`config.json`). " +
        `Workers' checkouts are in \`${i.worktreeRoot}\`.`,
      "",
      "**That folder is a temporary one.** macOS empties temporary folders on a restart or after they go unused for a while. " +
        "If it does, hcoord forgets your projects and their task history. Your repos, worktrees and branches aren't in it and are safe.",
      "",
      "**How it got there:** the Projects section was installed with `HCOORD_HOME` pointing at a test folder, so it has used that ever since.",
      "",
      "**The fix:** move the folder to the usual place and install the section again without `HCOORD_HOME`, once no coordinator or worker is running:",
      "",
      "```sh",
      `mv '${i.root}' ~/.herdr-coordinator`,
      "hcoord mod install",
      "```",
      "",
      "Then restart the coordinators (right-click a worktree, or click it), since running agents still write to the old folder.",
    ].join("\n");
  }

  renderInfo(t) {
    const i = props().info;
    const button = (id, label, bg, fg, onClick) =>
      h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1().border_color(id === "close" ? t.input : bg).bg(bg).text_color(fg)
        .cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick).child(label);
    return v_flex()
      .id("hc-info")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape" && e.key !== "enter") return;
        closeOverlay(props().overlay);
        cx.stop_propagation();
      })
      .size_full()
      .min_h(0)
      .p(18)
      .gap(12)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().text_color(t.foreground).child("Where hcoord keeps its data"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(TextView.markdown("hc-info-text", this.infoText()).selectable(true).scrollable(true).flex_1().min_h(0).text_size(13))
      .child(h_flex().justify_end().gap(8).text_size(12)
        .child(button("finder", "Show in Finder", t.raised, t.foreground, () => exec("open", [i.root]).catch(() => null)))
        .child(button("close", "Close", t.solid, t.solid_foreground, () => closeOverlay(props().overlay))));
  }

  // ------------------------------------------------------------- a new worktree

  initNew(cx) {
    const n = props().newWorktree;
    this.error = null;
    this.busyNew = null; // what it's doing, while it runs
    this.focusedField = "branch";
    // Start from: the repo's branches once `hcoord lane branches` answers (null: loading, false: it failed,
    // and the field is a text box as before); `base` the chosen one's ref (null: hcoord picks, the default).
    this.branches = null;
    this.base = null;
    this.picking = false; // the branch list is open
    this.at = 0; // the highlighted row of the open list
    this.branchInput = InputState.new({ value: "", placeholder: "new branch name" });
    this.baseInput = InputState.new({ value: "", placeholder: n.defaultBranch ?? "the main checkout's HEAD" });
    this.filterInput = InputState.new({ value: "", placeholder: "filter branches" });
    for (const [field, input] of [["branch", this.branchInput], ["base", this.baseInput]]) {
      input.on("change", (_e, cx) => {
        this.error = null;
        cx.notify();
      });
      input.on("submit", (_e, cx) => cx.spawn(async (cx) => this.createWorktree(cx)));
      input.on("focus", (_e, cx) => {
        this.focusedField = field;
        if (this.picking) this.closePicker();
        cx.notify();
      });
    }
    this.filterInput.on("change", (_e, cx) => {
      this.at = 0;
      cx.notify();
    });
    this.filterInput.on("submit", (_e, cx) => this.pick(this.shownBranches()[this.at], cx));
    this.filterInput.on("focus", (_e, cx) => {
      this.focusedField = "filter";
      cx.notify();
    });
    this.handle = cx.focus_handle();
    this.branchInput.focus();
    cx.timer.after(600, () => this.focusedField === "branch" && this.branchInput.focus());
    cx.spawn(async (cx) => this.loadBranches(cx));
  }

  /** `hcoord lane branches --json`: { default, selected, branches: [{ name, ref, remote }] }. */
  async loadBranches(cx) {
    const n = props().newWorktree;
    const r = await hcoord(["lane", "branches", n.project, "--json"]);
    let list = null;
    try {
      list = r.ok ? JSON.parse(r.stdout) : null;
    } catch {}
    if (Array.isArray(list?.branches) && list.branches.length) {
      this.branches = list;
      this.base = list.selected ?? null;
    } else this.branches = false;
    cx.notify();
  }

  /** The open list's rows: the branches whose name has the filter's text. */
  shownBranches() {
    const f = this.filterInput.value().trim().toLowerCase();
    return (this.branches?.branches ?? []).filter((b) => !f || b.name.toLowerCase().includes(f));
  }

  openPicker() {
    if (!this.branches || this.busyNew) return;
    this.picking = true;
    const rows = this.shownBranches();
    this.at = Math.max(0, rows.findIndex((b) => b.ref === this.base));
    this.filterInput.focus();
  }

  closePicker() {
    this.picking = false;
    this.filterInput.set_value("");
  }

  pick(b, cx) {
    if (b) this.base = b.ref;
    this.closePicker();
    this.error = null;
    this.branchInput.focus();
    cx.notify();
  }

  /** What `lane new` gets as --base: nothing for the default (hcoord picks local, else origin's). */
  chosenBase() {
    if (this.branches === false) return this.baseInput.value().trim() || null;
    if (!this.branches || !this.base || this.base === this.branches.selected) return null;
    return this.base;
  }

  /** Keys on the dialog: Esc closes the list if it's open, else the dialog; ↑ ↓ move in the open list
   *  (↓ in the Branch field opens it). */
  keyNew(e, cx) {
    if (e.key === "escape") {
      if (this.picking) {
        this.closePicker();
        this.branchInput.focus();
        cx.notify();
      } else closeOverlay(props().overlay);
      cx.stop_propagation();
      return;
    }
    if (!this.picking && e.key === "down" && this.focusedField === "branch" && this.branches) {
      this.openPicker(); // ↓ from the Branch field opens the list
      cx.stop_propagation();
      cx.notify();
      return;
    }
    if (!this.picking || (e.key !== "down" && e.key !== "up")) return;
    const n = this.shownBranches().length;
    if (n) this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n;
    cx.stop_propagation();
    cx.notify();
  }

  /** Create: `hcoord lane new`, then its coordinator in a space of its own (as go() opens any worktree). */
  async createWorktree(cx) {
    if (this.busyNew) return;
    const n = props().newWorktree;
    const branch = this.branchInput.value().trim();
    const from = this.chosenBase();
    if (!branch) {
      this.error = "Type a name for the new branch.";
      cx.notify();
      return;
    }
    this.closePicker();
    this.busyNew = "Creating the branch and its checkout…";
    this.error = null;
    cx.notify();
    const m = await makeCheckout(["lane", "new", branch, n.project, ...(from ? ["--base", from] : [])]);
    if (m.error) {
      this.busyNew = null;
      this.error = m.error;
      cx.notify();
      return;
    }
    this.busyNew = "Starting its coordinator…";
    cx.notify();
    const p = { slug: n.project, name: n.name };
    // hcoord makes the space around the coordinator and names it, but doesn't go there: the dialog closes
    // first, then one agent.focus goes to the new space, so the only switch is to it, once it's ready.
    const r = await openLane(p, m.w, { fresh: true, noFocus: true });
    this.busyNew = null;
    closeOverlay(props().overlay);
    if (r.terminal) run("agent.focus", { terminal: r.terminal });
    if (!r.ok) notify({ title: `Couldn't start ${spaceName(p, m.w)}'s coordinator`, body: r.text, level: "error", timeout: 12000 });
  }

  /** Start from: a button showing the chosen branch, which opens the list (and its filter) below it. */
  baseField(t) {
    const list = this.branches;
    const chosen = list?.branches.find((b) => b.ref === this.base);
    const label = !list ? "Loading branches…" : chosen ? chosen.name : "the main checkout's HEAD";
    return v_flex().gap(4)
      .child(div().text_size(11.5).text_color(t.dim).child("Start from"))
      .child(h_flex().id("hc-base").h(32).px(10).gap(8).items_center().rounded(6).border(1)
        .border_color(this.picking ? t.accent : t.input).bg(t.background)
        .when(Boolean(list), (el) => el.cursor_pointer().on_click((_e, cx) => {
          if (this.picking) {
            this.closePicker();
            this.branchInput.focus();
          } else this.openPicker();
          cx.notify();
        }))
        .child(div().flex_1().min_w(0).truncate().text_color(list ? t.foreground : t.dim).child(label))
        .when(Boolean(chosen?.remote), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("origin")))
        .when(Boolean(chosen && chosen.name === list?.default), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("default")))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(this.picking ? "▴" : "▾")));
  }

  /** The open branch list: a filter (type to narrow, ↑ ↓ to move, Enter to choose, Esc to close) and the rows. */
  branchList(t) {
    const rows = this.shownBranches();
    const row = (b, i) => {
      const on = i === this.at;
      return h_flex().id(`hc-br-${i}`).flex_none().h(28).px(10).gap(8).items_center().rounded(6).cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => this.pick(b, cx))
        .child(div().flex_1().min_w(0).truncate().text_color(b.ref === this.base ? t.accent : t.foreground).child(b.name))
        .when(b.remote, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("origin")))
        .when(b.name === this.branches.default, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("default")));
    };
    return v_flex().flex_1().min_h(0).gap(6)
      .child(Input.new(this.filterInput).h(30).px(10).items_center().rounded(6).border(1)
        .border_color(this.focusedField === "filter" ? t.accent : t.input).bg(t.background).text_color(t.foreground))
      .child(div().relative().flex_1().min_h(0).rounded(6).border(1).border_color(t.input)
        .child(v_flex().id("hc-br-list").size_full().p(3).overflow_y_scroll()
          .children(rows.map(row))
          .when(rows.length === 0, (el) => el.child(div().p(8).text_color(t.dim).child("No matching branches."))))
        .child(Scrollbar.vertical("hc-br-list").absolute().inset_0()));
  }

  renderNew(t) {
    const n = props().newWorktree;
    const field = (id, label, input) =>
      v_flex().gap(4)
        .child(div().text_size(11.5).text_color(t.dim).child(label))
        .child(Input.new(input).h(32).px(10).items_center().rounded(6).border(1)
          .border_color(this.focusedField === id ? t.accent : t.input).bg(t.background).text_color(t.foreground));
    const ready = !this.busyNew;
    const button = (id, label, bg, fg, onClick) =>
      h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1().border_color(id === "cancel" ? t.input : bg).bg(bg).text_color(fg)
        .when(ready || id === "cancel", (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick))
        .when(!ready && id !== "cancel", (el) => el.opacity(0.5))
        .child(label);
    return v_flex()
      .id("hc-new")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.keyNew(e, cx))
      .size_full()
      .min_h(0)
      .p(18)
      .gap(12)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().text_color(t.foreground).child(`New worktree of ${n.name}`))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().text_color(t.muted).child("A new branch, checked out in a space of its own with its coordinator."))
      .child(field("branch", "Branch", this.branchInput))
      .when(this.branches === false, (el) => el.child(field("base", "Start from", this.baseInput)))
      .when(this.branches !== false, (el) => el.child(this.baseField(t)))
      .when(this.picking, (el) => el.child(this.branchList(t)))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .when(!this.picking, (el) => el.child(div().flex_1()))
      .child(h_flex().justify_end().gap(8).text_size(12)
        .when(Boolean(this.busyNew), (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(this.busyNew)))
        .child(button("cancel", "Cancel", t.raised, t.foreground, () => closeOverlay(props().overlay)))
        .child(button("create", "Create", t.solid, t.solid_foreground, (_e, cx) => cx.spawn(async (cx) => this.createWorktree(cx)))));
  }

  // ------------------------------------------------------------- project settings dialog

  initSettings(cx) {
    this.loaded = null; // null: loading, true: loaded, false: it failed. Only true can be saved.
    this.saving = false;
    this.error = null;
    this.promptFocused = false;
    this.promptBox = TextareaState.new({ value: "", placeholder: "Nothing runs if this is empty.", rows: 8 });
    this.promptBox.on("change", (_e, cx) => {
      this.error = null;
      cx.notify();
    });
    for (const [event, on] of [["focus", true], ["blur", false]]) {
      this.promptBox.on(event, (_e, cx) => {
        this.promptFocused = on;
        cx.notify();
      });
    }
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(600, () => this.loaded && !this.promptFocused && this.promptBox.focus());
    cx.spawn(async (cx) => this.loadSettings(cx));
  }

  /** The box stays out of reach until this answers, so nothing typed can be lost and nothing empty saved. */
  async loadSettings(cx) {
    const r = await hcoord(["settings", "show", props().settings.project, "--json"]);
    const prompt = r.ok ? parsed(r.stdout)?.cleanupPrompt : undefined;
    if (typeof prompt === "string") {
      this.promptBox.set_value(prompt);
      this.loaded = true;
      this.promptBox.focus();
    } else {
      this.loaded = false;
      this.error = r.ok ? "hcoord's answer had no cleanup prompt." : (r.text || "hcoord failed").replace(/^hcoord: /, "");
    }
    cx.notify();
  }

  async saveSettings(cx) {
    if (!this.loaded || this.saving) return;
    this.saving = true;
    this.error = null;
    cx.notify();
    const { project } = props().settings;
    const r = await hcoordWithFile(this.promptBox.value(), (file) => ["settings", "set", project, "--cleanup-prompt-file", file]);
    this.saving = false;
    if (r.ok) return closeOverlay(props().overlay);
    this.error = (r.text || "hcoord failed").replace(/^hcoord: /, "");
    cx.notify();
  }

  /** One setting: label, control, then what it does. A new setting is one more of these in renderSettings. */
  settingField(t, label, control, helper) {
    return v_flex().flex_none().gap(4)
      .child(div().text_size(11.5).text_color(t.dim).child(label))
      .child(control)
      .child(div().text_color(t.muted).child(helper));
  }

  renderSettings(t) {
    const { name } = props().settings;
    const frame = (el) => el.w_full().h(170).px(10).py(8).rounded(6).border(1).bg(t.background).text_color(t.foreground);
    const box = this.loaded
      ? frame(Textarea.new(this.promptBox)).border_color(this.promptFocused ? t.accent : t.input)
      : frame(div()).border_color(t.input).text_color(t.dim).child(this.loaded === null ? "Loading…" : "Couldn't load this setting.");
    const button = (id, label, bg, fg, ready, onClick) =>
      h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1().border_color(id === "cancel" ? t.input : bg).bg(bg).text_color(fg)
        .when(ready, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick))
        .when(!ready, (el) => el.opacity(0.5))
        .child(label);
    return v_flex()
      .id("hc-settings")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        cx.stop_propagation();
        if (!this.saving) closeOverlay(props().overlay);
      })
      .size_full()
      .min_h(0)
      .p(18)
      .gap(12)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().flex_none().items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().text_color(t.foreground).child(`Settings for ${name}`))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      // Scrolls once settings outgrow the dialog. Presses stay here, so selecting text can't drag the dialog.
      .child(v_flex().id("hc-settings-form").flex_1().min_h(0).gap(12).overflow_y_scrollbar()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(this.settingField(t, "Cleanup prompt", box,
          "The worktree's coordinator runs this when a worktree of this project is deleted, before its folder is removed.")))
      .when(Boolean(this.error), (el) => el.child(div().flex_none().text_color(t.blocked).child(this.error)))
      .child(h_flex().flex_none().justify_end().gap(8).text_size(12)
        .when(this.saving, (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child("Saving…")))
        .child(button("cancel", "Cancel", t.raised, t.foreground, !this.saving, () => closeOverlay(props().overlay)))
        .child(button("save", "Save", t.solid, t.solid_foreground, Boolean(this.loaded) && !this.saving, (_e, cx) => cx.spawn(async (cx) => this.saveSettings(cx)))));
  }
}
