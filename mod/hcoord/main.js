// Projects: hcoord's projects as a sidebar section, beside Spaces and Agents.
// Each project shows its coordinator's status and, opened, its tasks by state.
// Click a project to go to its coordinator (started if it isn't running), a task
// to peek at its worker, + to make a project from a git folder. Data comes from
// `hcoord board --json`, refreshed when ~/.herdr-coordinator/projects changes;
// workers' terminals changing makes hcoord check them (`hcoord sync`).
// Installed by `hcoord mod install`; edit the copy in the hcoord repo, not this one.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  agents, terminals, panes, spaces, focused, run, exec, theme, notify, nextCommand,
  pickFolder, watchFolder, layout, home,
} from "herdr";
import { HCOORD } from "./hcoord-path.js";

const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
// How long after one try a project's coordinator isn't started again by itself.
const RETRY_MS = 60000;
// Changes the folder watch can't see (Claude's trust list): looked for this often.
const FALLBACK_MS = 60000;

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

// Task sections, in the order they show.
const GROUPS = [
  { id: "needs_you", label: "Needs you", states: ["needs_you"], tone: "blocked" },
  { id: "working", label: "Working", states: ["starting", "working"], tone: "working" },
  { id: "queued", label: "Queued", states: ["queued"] },
  { id: "todo", label: "To do", states: ["todo"] },
  { id: "failed", label: "Failed", states: ["failed"], tone: "blocked" },
  { id: "done", label: "Done", states: ["done", "cancelled"], folded: true },
];

/** hcoord's reasons end in "; hc read t7": the person has the click for that. */
const plain = (s) => (s ?? "").replace(/;\s*hc read \S+\s*$/, "");

export default class Projects extends View {
  init(_props, cx) {
    this.data = null; // hcoord board --json
    this.error = null;
    this.loading = false;
    this.again = false;
    this.syncing = false;
    this.syncAgain = false;
    this.signature = null; // the workers' terminals at the last sync
    this.open = load("open", {}); // slug -> shown open (a click); else open when it's here or needs you
    this.doneOpen = new Set(); // slugs whose Done group is open
    this.tried = {}; // slug -> when its coordinator was last started by itself
    this.busy = new Set(); // slugs being opened
    this.space = focused()?.space ?? null;
    this.seenSpaces = new Set(spaces().map((s) => s.id));
    this.dismissed = new Set(load("dismissed", []));
    this.offer = null; // { repo } the last "make it a project?" toast is about
    this.born = {}; // space -> when this copy first saw it
    this.refresh(cx);
    cx.timer.every(FALLBACK_MS, (cx) => this.refresh(cx));
    // New spaces settle (their first terminal's folder) for a moment before they're asked about.
    cx.timer.every(1500, (cx) => this.lookAtNewSpaces(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "new") await this.newProject(cx);
        if (c === "adopt" && this.offer) await this.adopt(this.offer.repo, cx);
        cx.notify();
      }
    });
  }

  // ------------------------------------------------------------- hcoord

  async hcoord(args) {
    const r = await exec(HCOORD[0], [...HCOORD.slice(1), ...args]);
    const text = (r.stdout + r.stderr).trim();
    return { ok: r.code === 0, text, stdout: r.stdout };
  }

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
          const r = await this.hcoord(["board", "--json"]);
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
      if (p.coordinator) watched.add(p.coordinator.address);
      for (const t of p.tasks) if (t.terminal && ["starting", "working", "needs_you"].includes(t.state)) watched.add(t.terminal);
    }
    const sig = all
      .filter((t) => watched.has(t.address))
      .map((t) => `${t.address}:${t.state}:${t.status ?? ""}:${t.turn ?? ""}`)
      .sort()
      .join(" ");
    if (sig === this.signature) return;
    const first = this.signature === null;
    this.signature = sig;
    if (first) return; // nothing changed yet, it's only the first look
    if (this.syncing) {
      this.syncAgain = true;
      return;
    }
    this.syncing = true;
    cx.spawn(async (cx) => {
      do {
        this.syncAgain = false;
        await this.hcoord(["sync"]).catch(() => null);
      } while (this.syncAgain);
      this.syncing = false;
      this.refresh(cx);
    });
  }

  // ------------------------------------------------------------- spaces and projects

  /** Where a space is: its first terminal's live folder, else the folder it was made in. */
  placeOf(s, ps) {
    const tabs = new Set((s.tabs ?? []).map((c) => c.id));
    return ps.find((p) => tabs.has(p.tab) && p.cwd && !within(p.cwd, this.data?.root))?.cwd || s.folder;
  }

  /** The project a space belongs to: it holds the coordinator, or it's in one of the repos. */
  projectOfSpace(s, ps, ags) {
    if (!this.data || s.machine) return null;
    for (const p of this.data.projects) {
      if (p.coordinator && ags.some((a) => a.address === p.coordinator.address && a.space === s.id)) return p;
    }
    const at = this.placeOf(s, ps);
    if (within(at, this.data.worktreeRoot)) return null; // a worker's worktree
    return this.data.projects.find((p) => p.repos.some((r) => within(at, r))) ?? null;
  }

  spaceOfProject(p, ps, ags) {
    return spaces().find((s) => this.projectOfSpace(s, ps, ags)?.slug === p.slug) ?? null;
  }

  coordinatorOf(p, all, ags) {
    if (!p.coordinator) return { live: false };
    const t = all.find((x) => x.address === p.coordinator.address && x.name === p.coordinator.name && x.state === "live");
    if (!t) return { live: false };
    const a = ags.find((x) => x.address === t.address);
    return { live: true, address: t.address, status: a?.status ?? null, agent: a ?? null };
  }

  /** Go to the project: its coordinator if it runs, else its space and a new coordinator there. */
  async go(p, cx, { auto = false, space = null } = {}) {
    const all = terminals();
    const ags = agents();
    const c = this.coordinatorOf(p, all, ags);
    if (c.live && c.agent) {
      if (!auto) run("agent.focus", { terminal: c.address });
      return;
    }
    if (this.busy.has(p.slug)) return;
    const ps = panes();
    let s = space ? { id: space } : this.spaceOfProject(p, ps, ags);
    if (!auto) {
      if (s) run("space.select", { id: s.id });
      else {
        run("space.new", { name: p.name, folder: p.repos[0] });
        s = null; // hcoord finds it by its folder
      }
    }
    this.busy.add(p.slug);
    cx.notify();
    const args = ["project", "open", p.slug];
    if (s) args.push("--space", s.id);
    const r = await this.hcoord(args).catch((e) => ({ ok: false, text: String(e) }));
    this.busy.delete(p.slug);
    if (!r.ok) notify({ title: `Couldn't open ${p.name}`, body: r.text, level: "error", timeout: 12000 });
    this.refresh(cx);
  }

  /** Switching to a project's space starts its coordinator when it isn't running (once a minute at most). */
  followSpace(cx) {
    const now = focused()?.space ?? null;
    if (now === this.space) return;
    this.space = now;
    if (!now || !this.data) return;
    const s = spaces().find((x) => x.id === now);
    const p = s && this.projectOfSpace(s, panes(), agents());
    if (!p || this.coordinatorOf(p, terminals(), agents()).live) return;
    if (Date.now() - (this.tried[p.slug] ?? 0) < RETRY_MS) return;
    this.tried[p.slug] = Date.now();
    cx.spawn(async (cx) => this.go(p, cx, { auto: true, space: now }));
  }

  // ------------------------------------------------------------- new projects

  async newProject(cx) {
    const folder = await pickFolder({ prompt: "Make project" });
    if (!folder) return;
    await this.adopt(folder, cx);
  }

  /** Makes a project of a git folder (its repo root), unless one has it, then goes there. */
  async adopt(folder, cx) {
    this.offer = null;
    const known = this.data?.projects.find((p) => p.repos.some((r) => within(folder, r)));
    if (known) return this.go(known, cx);
    const name = base(folder);
    const r = await this.hcoord(["project", "new", name, "--repo", folder, "--json"]).catch((e) => ({ ok: false, text: String(e) }));
    if (!r.ok) {
      notify({ title: `Couldn't make ${name} a project`, body: r.text, level: "error", timeout: 12000 });
      return;
    }
    let meta;
    try {
      meta = JSON.parse(r.stdout);
    } catch {
      meta = null;
    }
    const warning = r.text.split("\n").find((l) => l.startsWith("warning:"));
    if (warning) notify({ title: `${name}: Claude doesn't trust this repo yet`, body: warning.replace(/^warning:\s*/, ""), level: "warning", timeout: 15000 });
    this.open[meta?.slug ?? name] = true;
    localStorage.setItem("open", JSON.stringify(this.open));
    this.refresh(cx);
    if (meta) await this.go({ ...meta, tasks: [], coordinator: null }, cx);
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
      if (this.data.projects.some((p) => p.repos.some((r) => within(at, r)))) continue;
      cx.spawn(async (cx) => {
        const r = await exec("git", ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"], { cwd: at }).catch(() => null);
        if (!r || r.code !== 0) return;
        const [top, gitDir, common] = r.stdout.trim().split("\n");
        // A linked worktree (git dir isn't the common one) belongs to its main checkout.
        if (!top || gitDir !== common) return;
        if (this.dismissed.has(top) || this.data.projects.some((p) => p.repos.includes(top))) return;
        this.offer = { repo: top };
        this.dismissed.add(top); // asked once; + still makes it a project later
        localStorage.setItem("dismissed", JSON.stringify([...this.dismissed]));
        notify({
          title: `Make ${base(top)} a project?`,
          body: `A coordinator for ${tilde(top)}: click to set it up.`,
          level: "info",
          timeout: 15000,
          action: { name: "hcoord.adopt" },
        });
        cx.notify();
      });
    }
  }

  // ------------------------------------------------------------- drawing

  status(t, c, busy) {
    if (busy) return svg(ICON("spinner")).size(12).mx(1).flex_none().text_color(t.dim).spin(900);
    if (!c.live) return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.dim + "80");
    if (c.status === "working") return svg(ICON("spinner")).size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (c.status === "blocked") return this.pill(t, "Needs you", t.blocked);
    if (c.status === "done") return div().size(7).mx(3).flex_none().rounded(4).bg(t.done);
    if (c.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    // Running, no agent status: a shell after a restart, or a prompt.
    return div().size(14).flex_none().rounded(4).bg(t.unknown + "26").text_size(10.5).font_bold().text_color(t.unknown).flex().items_center().justify_center().child("?");
  }

  pill(t, text, color) {
    return div().flex_none().px(6).h(18).rounded(5).bg(color + "26").text_size(10.5).font_semibold().text_color(color).flex().items_center().child(text);
  }

  taskMark(t, task) {
    switch (task.state) {
      case "needs_you":
        return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
      case "starting":
      case "working":
        return svg(ICON("spinner")).size(12).mx(1).flex_none().text_color(t.working).spin(900);
      case "failed":
        return svg(ICON("x")).size(12).mx(1).flex_none().text_color(t.blocked);
      case "done":
        return svg(ICON("check")).size(12).mx(1).flex_none().text_color(t.done);
      case "cancelled":
        return svg(ICON("minus")).size(12).mx(1).flex_none().text_color(t.dim);
      case "queued":
        return svg(ICON("clock")).size(12).mx(1).flex_none().text_color(t.dim);
      default:
        return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.dim);
    }
  }

  taskRow(t, p, task, all) {
    const live = task.terminal && all.some((x) => x.address === task.terminal && x.state === "live");
    const note =
      task.state === "needs_you" ? plain(task.reason)
      : task.state === "failed" || task.state === "done" ? plain(task.summary)
      : task.state === "queued" && task.waitingOn.length ? `after ${task.waitingOn.join(", ")}`
      : null;
    const quiet = task.state === "done" || task.state === "cancelled";
    return v_flex()
      .id(`task-${task.id}`)
      .pl(30)
      .pr(8)
      .py(4)
      .flex_none()
      .rounded(8)
      .gap(1)
      .when(Boolean(live), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => run("terminal.peek", { terminal: task.terminal })))
      .tooltip([`${task.id} ${task.title}`, plain(task.reason) || plain(task.summary)].filter(Boolean).join("\n\n"))
      .child(h_flex().gap(8).items_center()
        .child(this.taskMark(t, task))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(task.id))
        .child(div().flex_1().min_w(0).truncate().text_color(quiet ? t.muted : t.foreground).child(task.title)))
      .when(Boolean(note), (el) => el.child(div().pl(20).truncate().text_size(11.5).text_color(task.state === "needs_you" ? t.blocked : t.dim).child(note)));
  }

  groupHeader(t, p, g, n) {
    const folded = g.folded && !this.doneOpen.has(p.slug);
    return h_flex()
      .id(`grp-${p.slug}-${g.id}`)
      .pl(30)
      .pr(8)
      .h(22)
      .pt(4)
      .flex_none()
      .gap(6)
      .items_center()
      .text_size(11)
      .font_medium()
      .text_color(t[g.tone] ?? t.dim)
      .when(Boolean(g.folded), (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => {
        folded ? this.doneOpen.add(p.slug) : this.doneOpen.delete(p.slug);
        cx.notify();
      }))
      .child(div().child(g.label))
      .child(div().text_color(t.dim).child(String(n)))
      .when(Boolean(g.folded), (el) => el.child(svg(ICON(folded ? "chevron-right" : "chevron-down")).size(11).flex_none().text_color(t.dim)));
  }

  projectRows(t, p, ctx) {
    const { all, ags, ps } = ctx;
    const c = this.coordinatorOf(p, all, ags);
    const s = this.spaceOfProject(p, ps, ags);
    const needs = p.tasks.filter((x) => x.state === "needs_you").length;
    const working = p.tasks.filter((x) => x.state === "working" || x.state === "starting").length;
    const here = s && s.id === focused()?.space;
    const isOpen = this.open[p.slug] ?? (here || needs > 0);
    const untrusted = Object.entries(p.trust ?? {}).filter(([, v]) => v === false).map(([r]) => r);
    const busy = this.busy.has(p.slug);

    const fold = div()
      .id(`fold-${p.slug}`)
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
        this.open[p.slug] = !isOpen;
        localStorage.setItem("open", JSON.stringify(this.open));
        cx.notify();
      })
      .child(svg(ICON(isOpen ? "chevron-down" : "chevron-right")).size(11));

    const head = h_flex()
      .id(`proj-${p.slug}`)
      .px(8)
      .h(30)
      .flex_none()
      .rounded(8)
      .items_center()
      .gap(6)
      .when(Boolean(here), (el) => el.bg(t.selected))
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .tooltip(c.live ? `${p.name}: show its coordinator` : `${p.name}: start its coordinator`)
      .on_click((_e, cx) => cx.spawn(async (cx) => this.go(p, cx)))
      .child(fold)
      .child(div().flex_1().min_w(0).truncate().text_color(c.live || here ? t.foreground : t.muted).child(p.name))
      .when(!isOpen && working > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.working).child(`${working} working`)))
      .when(!isOpen && needs > 0, (el) => el.child(this.pill(t, String(needs), t.blocked)))
      .child(this.status(t, c, busy));

    if (!isOpen) return [head];
    const rows = [head];
    for (const r of untrusted) {
      rows.push(h_flex()
        .id(`trust-${p.slug}-${r}`)
        .pl(30)
        .pr(8)
        .py(4)
        .flex_none()
        .rounded(8)
        .gap(6)
        .cursor_pointer()
        .hover((el) => el.bg(t.hover))
        .tooltip(`Claude hasn't been told to trust ${tilde(r)}, so workers there would stop at its prompt. Click to open Claude there and answer it yourself.`)
        .on_click(() => run("tab.new", { name: `trust ${base(r)}`, folder: r, argv: ["claude"] }))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.blocked).child(`Claude doesn't trust ${tilde(r)} yet`)));
    }
    if (c.live && !c.agent) {
      rows.push(div().pl(30).pr(8).py(2).text_size(11.5).text_color(t.unknown).truncate()
        .child("Coordinator reports no status (a shell after a restart?)"));
    }
    if (!p.tasks.length) {
      rows.push(div().pl(30).pr(8).py(4).text_size(11.5).text_color(t.dim).child(c.live ? "No tasks yet: tell the coordinator what to do." : "No tasks yet."));
    }
    for (const g of GROUPS) {
      const members = p.tasks.filter((x) => g.states.includes(x.state));
      if (!members.length) continue;
      rows.push(this.groupHeader(t, p, g, members.length));
      if (g.folded && !this.doneOpen.has(p.slug)) continue;
      // Newest done first; the rest by number.
      const list = g.folded ? [...members].sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1)) : members;
      for (const task of list) rows.push(this.taskRow(t, p, task, all));
    }
    rows.push(div().h(6).flex_none());
    return rows;
  }

  railRow(t, p, ctx) {
    const c = this.coordinatorOf(p, ctx.all, ctx.ags);
    const needs = p.tasks.filter((x) => x.state === "needs_you").length;
    return h_flex()
      .id(`rail-${p.slug}`)
      .h(26)
      .px(8)
      .flex_none()
      .items_center()
      .gap(4)
      .hover((s) => s.bg(t.hover))
      .tooltip(p.name)
      .on_click((_e, cx) => cx.spawn(async (cx) => this.go(p, cx)))
      .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_size(11).text_color(c.live ? t.foreground : t.muted).child(p.prefix))
      .child(h_flex().w(14).flex_none().items_center().justify_center()
        .child(needs ? div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child(String(needs)) : this.status(t, c, this.busy.has(p.slug))));
  }

  render(cx) {
    const t = theme();
    const all = terminals();
    const ags = agents();
    const ps = panes();
    this.maybeSync(all, cx);
    this.followSpace(cx);
    const collapsed = narrow();
    const ctx = { all, ags, ps };
    const projects = this.data?.projects ?? [];

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
      .child(svg(ICON("plus")).size(14));

    const body = collapsed
      ? projects.map((p) => this.railRow(t, p, ctx))
      : projects.flatMap((p) => this.projectRows(t, p, ctx));

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
      .when(!this.error && this.data && !projects.length && !collapsed, (el) => el.child(
        div().px(16).text_size(12).text_color(t.dim).child("No projects yet. + makes one from a git folder, with a coordinator agent you talk to.")))
      .child(v_flex().id("hc-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("always").children(body))
      .when(collapsed, (el) => el.child(h_flex().h(28).items_center().justify_center().child(plus)));
  }
}
