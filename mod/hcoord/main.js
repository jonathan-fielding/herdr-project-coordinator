// Projects: hcoord's projects as a sidebar section, beside Spaces and Agents.
// A project is a repo; under it, its worktrees (the main checkout and Herdr's worktree
// spaces), each with a coordinator agent; under each worktree, its tasks by state.
// Click a worktree to go to its coordinator (started if it isn't running), a task to peek
// at its worker or read its log. Going to a project's worktree space starts its coordinator.
// The same mod with props { log } is a pane showing one agent's log (its transcript); with
// props { menu } a right-click menu, with props { ask } a dialog asking before a delete, and with
// props { info } a dialog explaining a warning (where hcoord keeps its data).
// Data: `hcoord board --json`, refreshed when ~/.herdr-coordinator/projects changes; workers'
// terminals changing makes hcoord check them (`hcoord sync`).
// Installed by `hcoord mod install`; edit the copy in the hcoord repo, not this one.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import {
  agents, terminals, panes, spaces, focused, run, exec, theme, notify, nextCommand,
  pickFolder, watchFolder, layout, home, props, openOverlay, closeOverlay, shared, setShared,
} from "herdr";
import { HCOORD } from "./hcoord-path.js";

const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
// How long after one try a worktree's coordinator isn't started again by itself.
const RETRY_MS = 60000;
// Changes the folder watch can't see (Claude's trust list, new git worktrees): looked for this often.
const FALLBACK_MS = 30000;
const ACTIVE = ["starting", "working", "needs_you"];

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

/** hcoord's reasons end in "; hc read t7" or a command to run: the person has clicks for those. */
const plain = (s) => (s ?? "").replace(/;\s*(hc read \S+|hcoord task retry \S+.*)\s*$/, "");

async function hcoord(args) {
  const r = await exec(HCOORD[0], [...HCOORD.slice(1), ...args]);
  return { ok: r.code === 0, text: (r.stdout + r.stderr).trim(), stdout: r.stdout };
}

export default class Projects extends View {
  init(_props, cx) {
    if (props()?.log) return this.initLog(cx);
    if (props()?.menu) return this.initMenu(cx);
    if (props()?.ask) return this.initAsk(cx);
    if (props()?.info) return this.initInfo(cx);
    this.data = null; // hcoord board --json
    this.error = null;
    this.loading = false;
    this.again = false;
    this.syncing = false;
    this.syncAgain = false;
    this.signature = null; // the agents' terminals at the last sync
    this.open = load("open", {}); // "p:<slug>" / "w:<path>" -> shown open (a click); else a default
    this.mergedOpen = new Set(); // worktree paths whose Merged group is open
    this.tried = {}; // worktree path -> when its coordinator was last started by itself
    this.busy = new Set(); // worktree paths being opened
    this.space = focused()?.space ?? null;
    this.seenSpaces = new Set(spaces().map((s) => s.id));
    this.born = {}; // space -> when this copy first saw it
    this.dismissed = new Set(load("dismissed", []));
    this.order = load("order", []); // project slugs in the order the person dragged them to
    this.drag = null; // { from, over }: a project header pressed, and the project it's over
    this.offer = null; // { repo } the last "make it a project?" toast is about
    this.refresh(cx);
    cx.timer.every(FALLBACK_MS, (cx) => this.refresh(cx));
    // New spaces settle (their first terminal's folder) for a moment before they're asked about.
    cx.timer.every(1500, (cx) => this.lookAtNewSpaces(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "new") await this.newProject(cx);
        if (c === "adopt" && this.offer) await this.adopt(this.offer.repo, cx);
        if (c === "raise-pr") await this.raisePrFromMenu(cx);
        cx.notify();
      }
    });
  }

  // ------------------------------------------------------------- data

  refresh(cx) {
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
          if (!r.ok) throw new Error(r.text || "hcoord board failed");
          this.data = JSON.parse(r.stdout);
          this.error = null;
          if (!this.watching) this.watch(cx);
        } catch (e) {
          this.error = String(e?.message ?? e);
        }
        cx.notify();
      } while (this.again);
      this.loading = false;
    });
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
        await hcoord(["sync"]).catch(() => null);
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
    return spaces().find((s) => !s.machine && this.worktreeAt(this.placeOf(s, ps))?.w.path === w.path) ?? null;
  }

  coordinatorOf(w, all, ags) {
    const c = w.lane?.coordinator;
    if (!c) return { live: false };
    const t = all.find((x) => x.address === c.address && x.name === c.name && x.state === "live");
    if (!t) return { live: false, session: c.session };
    const a = ags.find((x) => x.address === t.address);
    return { live: true, address: t.address, status: a?.status ?? null, agent: a ?? null, session: c.session };
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
   *  With `say`, that text is then typed to the coordinator (`hcoord lane say`, which waits for a new one to be up). */
  async go(p, w, cx, { auto = false, space = null, restart = false, say = null } = {}) {
    if (w.virtual) {
      // The default branch isn't checked out anywhere: make its worktree (where Herdr would), then go there.
      if (auto || this.busy.has(w.path)) return;
      this.busy.add(w.path);
      cx.notify();
      const r = await hcoord(["lane", "checkout", w.branch, p.slug, "--json"]).catch((e) => ({ ok: false, text: String(e) }));
      this.busy.delete(w.path);
      let made = null;
      try {
        made = r.ok ? JSON.parse(r.stdout) : null;
      } catch {}
      if (!made) {
        notify({ title: `Couldn't check out ${w.branch}`, body: r.text, level: "error", timeout: 12000 });
        this.refresh(cx);
        return;
      }
      w = { path: made.path, branch: w.branch, lane: { key: made.lane, path: made.path }, main: false };
    }
    const ags = agents();
    const c = this.coordinatorOf(w, terminals(), ags);
    if (c.live && c.agent && !restart) {
      if (!auto) run("agent.focus", { terminal: c.address });
      if (!say) return;
    }
    if (this.busy.has(w.path)) return;
    let s = space ? { id: space } : this.spaceOf(w, panes(), ags);
    if (!auto && !(c.live && c.agent && say)) {
      if (s) run("space.select", { id: s.id });
      else run("space.new", { name: w.main ? p.name : `${p.name} · ${w.branch ?? base(w.path)}`, folder: w.path });
    }
    this.busy.add(w.path);
    cx.notify();
    const args = say ? ["lane", "say", w.path, say] : ["lane", "open", w.path];
    if (s) args.push("--space", s.id);
    if (restart && !say) args.push("--restart");
    const r = await hcoord(args).catch((e) => ({ ok: false, text: String(e) }));
    this.busy.delete(w.path);
    if (!r.ok) notify({ title: `Couldn't ${say ? "ask" : "open"} ${p.name} · ${w.branch ?? base(w.path)}${say ? "'s coordinator" : ""}`, body: r.text, level: "error", timeout: 12000 });
    else if (say) notify({ title: `Asked ${w.branch ?? base(w.path)}'s coordinator`, body: say, level: "info", timeout: 6000 });
    this.refresh(cx);
  }

  /** Switching to a project's worktree space starts its coordinator when it isn't running (once a minute at most). */
  followSpace(cx) {
    const now = focused()?.space ?? null;
    if (now === this.space) return;
    this.space = now;
    if (!now || !this.data) return;
    const s = spaces().find((x) => x.id === now);
    if (!s || s.machine) return;
    const hit = this.worktreeAt(this.placeOf(s, panes()));
    if (!hit || hit.w.gone) return;
    if (this.coordinatorOf(hit.w, terminals(), agents()).live) return;
    if (Date.now() - (this.tried[hit.w.path] ?? 0) < RETRY_MS) return;
    this.tried[hit.w.path] = Date.now();
    cx.spawn(async (cx) => this.go(hit.p, hit.w, cx, { auto: true, space: now }));
  }

  newWorktree(p) {
    const s = this.spaceOf({ path: p.repo, lane: p.lanes.find((l) => l.key === "root") }, panes(), agents());
    // Herdr's own dialog: it makes the checkout and a space for it; going there starts its coordinator.
    openOverlay({ mod: "worktree", kind: "dialog", width: 460, height: 280, props: { space: s?.id, folder: p.repo, action: "new" } });
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
    const folder = await pickFolder({ prompt: "Make project" });
    if (!folder) return;
    await this.adopt(folder, cx);
  }

  /** Makes a project of a git folder's repo, unless one has it, then goes to that checkout. */
  async adopt(folder, cx) {
    this.offer = null;
    const known = this.worktreeAt(folder);
    if (known) return this.go(known.p, known.w, cx);
    const name = base(folder);
    const r = await hcoord(["project", "new", name, "--repo", folder, "--json"]).catch((e) => ({ ok: false, text: String(e) }));
    if (!r.ok) {
      notify({ title: `Couldn't make ${name} a project`, body: r.text, level: "error", timeout: 12000 });
      return;
    }
    const warning = r.text.split("\n").find((l) => l.startsWith("warning:"));
    if (warning) notify({ title: `${name}: Claude doesn't trust this repo yet`, body: warning.replace(/^warning:\s*/, ""), level: "warning", timeout: 15000 });
    let slug = null;
    try {
      slug = JSON.parse(r.stdout).slug;
    } catch {}
    if (slug) {
      this.open[`p:${slug}`] = true;
      save("open", this.open);
    }
    // Open the checkout that was picked (a worktree or the main one).
    const lr = await hcoord(["lane", "open", folder]).catch((e) => ({ ok: false, text: String(e) }));
    if (!lr.ok) notify({ title: `Couldn't start ${name}'s coordinator`, body: lr.text, level: "error", timeout: 12000 });
    this.refresh(cx);
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
        if (this.dismissed.has(repo) || this.data.projects.some((p) => p.repo === repo)) return;
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
    if (!c.live) return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.dim + "80");
    if (c.status === "working") return svg(ICON("spinner")).size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (c.status === "blocked") return this.pill(t, "Needs you", t.blocked);
    if (c.status === "done") return div().size(7).mx(3).flex_none().rounded(4).bg(t.done);
    if (c.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    // Running, no agent status: a shell after a restart, or a prompt.
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
        : `${tilde(w.path)}\n${c.live ? "Click: show its coordinator" : w.gone ? "This worktree is gone" : "Click: start its coordinator"}`)
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

    if (!isOpen) return [head];
    const rows = [head];
    if (c.live && !c.agent) {
      rows.push(h_flex()
        .id(`restart-${w.path}`)
        .pl(44).pr(8).py(3).flex_none().rounded(8).gap(6)
        .cursor_pointer()
        .hover((el) => el.bg(t.hover))
        .tooltip("It reports no status: it's waiting at a prompt (Claude's trust question?), or it's a plain shell after a restart. Click: show it. The button at the end replaces it with a fresh Claude.")
        .on_click(() => run("terminal.peek", { terminal: c.address }))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.unknown).child("Coordinator reports no status: look at it"))
        .child(this.iconButton(`restartbtn-${w.path}`, t, "square-pen", "Replace it with a fresh Claude, carrying on its conversation (after a restart)", (cx) => cx.spawn(async (cx) => this.go(p, w, cx, { restart: true })))));
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
    const isOpen = this.open[key] ?? (here || needs > 0 || this.data.projects.length === 1);
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
        this.menuFor({ kind: "project", project: p.slug, name: p.name, repo: p.repo });
      })
      .child(this.fold(t, key, isOpen))
      .child(div().flex_1().min_w(0).truncate().font_medium().text_color(here ? t.foreground : t.muted).child(p.name))
      .when(!isOpen && needs > 0, (el) => el.child(this.badge(t, String(needs), t.blocked)))
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
      .tooltip("New project from a git folder")
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
        .child(plus)))
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
        div().px(16).text_size(12).text_color(t.dim).child("No projects yet. The folder button makes one from a git repo; each of its worktrees gets a coordinator agent you talk to.")))
      .child(v_flex().id("hc-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("always")
        // A drag let go off the projects, or taken out of the list, is dropped.
        .on_mouse_up("left", (_e, cx) => this.endDrag(cx))
        .on_hover((hovered, cx) => { if (!hovered) this.endDrag(cx); })
        .children(body))
      .when(collapsed, (el) => el.child(h_flex().h(28).items_center().justify_center().child(plus)));
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
        { label: "New worktree", icon: "git-branch", go: () => openOverlay({ mod: "worktree", kind: "dialog", width: 460, height: 280, props: { folder: m.repo, action: "new" } }) },
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
    else items.push({ label: "Delete worktree…", icon: "x", danger: true, go: () => openOverlay({ mod: "hcoord", kind: "dialog", width: 460, height: 300, props: { ask: { ...m, what: "worktree" } } }) });
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
      const r = await hcoord(args).catch((e) => ({ ok: false, text: String(e) }));
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

  async doDelete(files, cx) {
    const a = props().ask;
    const plan = this.plan;
    if (!plan || this.busyAsk) return;
    this.busyAsk = true;
    this.error = null;
    cx.notify();
    let args, closing = [];
    if (a.what === "project") {
      args = ["project", "delete", a.project, ...(files ? ["--files"] : [])];
      // Its folders are about to go: their spaces first, so no shell sits in them.
      if (files) closing = this.spacesIn(plan.checkouts.map((c) => c.path));
    } else {
      args = ["lane", "remove", plan.path, ...(plan.changed.length ? ["--force"] : [])];
      closing = this.spacesIn([plan.path]);
    }
    for (const s of closing) run("space.close", { id: s.id, confirmed: true });
    const r = await hcoord(args).catch((e) => ({ ok: false, text: String(e) }));
    this.busyAsk = false;
    if (!r.ok) {
      this.error = r.text;
      cx.notify();
      return;
    }
    closeOverlay(props().overlay);
    const what = a.what === "project" ? `${a.name} deleted${files ? ", files too" : " from Herdr"}` : `Worktree ${a.branch} deleted`;
    notify({ title: what, body: r.text.split("\n").slice(-3).join("\n"), level: "info", timeout: 8000 });
  }

  askLines(t) {
    const a = props().ask;
    const p = this.plan;
    const line = (text, color = t.muted) => div().text_color(color).child(text);
    const out = [];
    if (!p) return [line(this.error ? "" : "Looking…", t.dim)];
    if (a.what === "worktree") {
      out.push(line(`${tilde(p.path)} goes, with its Herdr space. The branch ${p.branch ?? "(detached)"} is kept.`));
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
}
