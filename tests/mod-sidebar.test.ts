// The sidebar mod (mod/hcoord/main.js) runs inside Herdr; here it's loaded with stand-ins for Herdr's
// modules so its refresh and follow-the-space logic can be checked without the app.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers.ts";

// A copy of the mod beside the hcoord-path.js that `hcoord mod install` would write.
const MOD = tempDir("mod");
copyFileSync(join(import.meta.dir, "..", "mod", "hcoord", "main.js"), join(MOD, "main.js"));
writeFileSync(join(MOD, "hcoord-path.js"), 'export const HCOORD = ["hcoord"];\n');

// What the stand-in Herdr reports, changed by each test.
const world = {
  focused: null as string | null,
  spaces: [] as any[],
  panes: [] as any[],
  terminals: [] as any[],
  agents: [] as any[],
  board: null as any,
  boardRuns: 0,
  calls: [] as string[][],
  timers: [] as { ms: number; fn: (cx: any) => void }[],
  props: {} as any,
  runs: [] as [string, any][],
  overlays: [] as any[],
  closed: [] as string[],
  notes: [] as any[],
  /** Everything the mod asked of Herdr and hcoord, in order: "run <name>", "close <id>", "hcoord <args…>". */
  events: [] as string[],
  /** Answers for hcoord commands by their first two words ("lane new"), else "{}". */
  answers: {} as Record<string, { code: number; stdout: string; stderr: string }>,
};

/** A stand-in text field: a value, and handlers the test can fire. */
class FakeInput {
  text: string;
  handlers: Record<string, (e: any, cx: any) => void> = {};
  constructor(o: { value?: string }) {
    this.text = o.value ?? "";
  }
  static new(o: { value?: string }) {
    const i = new FakeInput(o);
    inputs.push(i);
    return i;
  }
  value() {
    return this.text;
  }
  on(ev: string, fn: (e: any, cx: any) => void) {
    this.handlers[ev] = fn;
  }
  set_value(v: string) {
    this.text = v;
  }
  focus() {}
}
const inputs: FakeInput[] = [];

mock.module("gpui-kit", () => ({ View: class {}, div: () => ({}), svg: () => ({}) }));
mock.module("gpui-base", () => ({ v_flex: () => ({}), h_flex: () => ({}), TextView: class {}, InputState: FakeInput, Input: { new: () => ({}) }, Scrollbar: { vertical: () => ({}) } }));
mock.module("herdr", () => ({
  agents: () => world.agents,
  terminals: () => world.terminals,
  panes: () => world.panes,
  spaces: () => world.spaces,
  focused: () => (world.focused ? { space: world.focused } : null),
  run: (name: string, args: any) => {
    world.runs.push([name, args]);
    world.events.push(`run ${name} ${JSON.stringify(args)}`);
  },
  exec: async (cmd: string, args: string[]) => {
    world.calls.push([cmd, ...args]);
    world.events.push([cmd, ...args].join(" "));
    const answer = world.answers[args.slice(0, 2).join(" ")];
    if (answer) return answer;
    if (args[0] === "board") {
      world.boardRuns++;
      return { code: 0, stdout: JSON.stringify(world.board), stderr: "" };
    }
    if (cmd === "git") return { code: 0, stdout: "/r/.git\n", stderr: "" };
    return { code: 0, stdout: "{}", stderr: "" };
  },
  theme: () => ({}),
  notify: (n: any) => void world.notes.push(n),
  nextCommand: () => new Promise(() => {}),
  pickFolder: async () => null,
  watchFolder: () => new Promise(() => {}),
  layout: () => null,
  home: () => "/home",
  props: () => world.props,
  openOverlay: (o: any) => void world.overlays.push(o),
  closeOverlay: (id: string) => {
    world.closed.push(id);
    world.events.push(`close ${id}`);
  },
  shared: () => null,
  setShared: () => {},
}));
(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {} };

const { default: Projects } = await import(join(MOD, "main.js"));

/** A stand-in cx. Some spawned tasks never end (the folder watch, the command loop), so settle()
 *  just lets the stand-in calls, which answer at once, run through. */
function makeCx() {
  const cx: any = {
    spawn: (fn: (cx: any) => Promise<unknown>) => void Promise.resolve().then(() => fn(cx)),
    notify: () => {},
    timer: { every: (ms: number, fn: (cx: any) => void) => world.timers.push({ ms, fn }), after: () => {} },
    focus_handle: () => ({ focus() {} }),
    async settle() {
      for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 1));
    },
  };
  return cx;
}

const project = (checkouts: string[], lanes: any[] = []) => ({
  root: "/data",
  worktreeRoot: "/data/worktrees",
  projects: [{ slug: "r", name: "r", repo: "/r", checkouts: checkouts.map((path) => ({ path, branch: base(path) })), lanes, tasks: [], defaultBranch: null }],
});
const base = (p: string) => p.split("/").pop();
const laneOpens = () => world.calls.filter((c) => c.includes("lane") && c.includes("open"));

beforeEach(() => {
  world.focused = "s1";
  world.spaces = [{ id: "s1", folder: "/r", tabs: [] }];
  world.panes = [];
  world.terminals = [];
  world.agents = [];
  world.board = project(["/r"]);
  world.boardRuns = 0;
  world.calls = [];
  world.timers = [];
  world.props = {};
  world.runs = [];
  world.overlays = [];
  world.closed = [];
  world.notes = [];
  world.events = [];
  world.answers = {};
  inputs.length = 0;
});

async function start() {
  const cx = makeCx();
  const v: any = new Projects();
  v.init({}, cx);
  await cx.settle();
  return { v, cx };
}

describe("sidebar refresh", () => {
  test("has its own, shorter fallback interval", async () => {
    await start();
    const refreshTimer = world.timers.find((t) => t.ms !== 1500);
    expect(refreshTimer?.ms).toBe(8000);
  });

  test("a new space in a known project's repo but no known checkout refreshes the board", async () => {
    const { v, cx } = await start();
    expect(world.boardRuns).toBe(1);
    world.spaces.push({ id: "s2", folder: "/home/wt/feature", tabs: [] });
    const realNow = Date.now;
    try {
      v.lookAtNewSpaces(cx); // first sight: settling
      Date.now = () => realNow() + 3000;
      v.lookAtNewSpaces(cx);
      await cx.settle();
    } finally {
      Date.now = realNow;
    }
    expect(world.calls.some((c) => c[0] === "git" && c.includes("--git-common-dir"))).toBe(true);
    expect(world.boardRuns).toBe(2);
  });

  test("a space that isn't a known worktree yet starts its coordinator once a refresh finds it", async () => {
    const { v, cx } = await start();
    // Herdr's New worktree dialog: a checkout and a space, focused, before the board knows it.
    world.spaces.push({ id: "s2", folder: "/home/wt/feature", tabs: [] });
    world.focused = "s2";
    v.followSpace(cx);
    await cx.settle();
    expect(v.pendingSpace).toBe("s2");
    expect(laneOpens()).toHaveLength(0);

    // A refresh that still doesn't know it: stays pending, nothing started.
    v.refresh(cx);
    await cx.settle();
    expect(v.pendingSpace).toBe("s2");
    expect(laneOpens()).toHaveLength(0);

    // The board catches up: the coordinator starts, once.
    world.board = project(["/r", "/home/wt/feature"]);
    v.refresh(cx);
    await cx.settle();
    expect(v.pendingSpace).toBe(null);
    expect(laneOpens()).toHaveLength(1);
    expect(laneOpens()[0]).toContain("/home/wt/feature");
    v.refresh(cx);
    await cx.settle();
    expect(laneOpens()).toHaveLength(1);
  });

  test("going to another space drops the pending one", async () => {
    const { v, cx } = await start();
    world.spaces.push({ id: "s2", folder: "/home/wt/feature", tabs: [] });
    world.focused = "s2";
    v.followSpace(cx);
    expect(v.pendingSpace).toBe("s2");
    world.focused = "s1";
    v.followSpace(cx);
    await cx.settle();
    expect(v.pendingSpace).toBe(null);

    // Even if the focus moves without followSpace seeing it, a refresh doesn't start a space that isn't focused.
    world.focused = "s2";
    v.followSpace(cx);
    world.focused = "s1";
    world.board = project(["/r", "/home/wt/feature"]);
    v.refresh(cx);
    await cx.settle();
    expect(v.pendingSpace).toBe(null);
    expect(laneOpens().some((c) => c.includes("/home/wt/feature"))).toBe(false);
  });
});

describe("new worktree", () => {
  const laneNews = () => world.calls.filter((c) => c[1] === "lane" && c[2] === "new");
  const p = () => world.board.projects[0];
  const made = (branch: string) => ({
    code: 0,
    stdout: JSON.stringify({ project: "r", lane: branch, path: `/home/.herdr/worktrees/r/${branch}`, branch, base: "main", created: true }),
    stderr: "",
  });

  /** The dialog, as Herdr opens it from the sidebar's openOverlay call. */
  function dialog(overlay: any) {
    world.props = { ...overlay.props, overlay: "ov1" };
    const cx = makeCx();
    const v: any = new Projects();
    v.init({}, cx);
    return { d: v, cx, branch: v.branchInput as FakeInput, from: v.baseInput as FakeInput, filter: v.filterInput as FakeInput };
  }

  test("the + button and the project menu's New worktree open hcoord's own dialog, not Herdr's", async () => {
    world.board.projects[0].defaultBranch = { name: "main", path: "/home/.herdr/worktrees/r/main", checkedOut: true };
    const { v } = await start();
    v.newWorktree(p());
    expect(world.overlays).toHaveLength(1);
    expect(world.overlays[0]).toMatchObject({ mod: "hcoord", kind: "dialog", props: { newWorktree: { project: "r", name: "r", defaultBranch: "main" } } });

    world.props = { menu: { kind: "project", project: "r", name: "r", repo: "/r", defaultBranch: "main" }, overlay: "menu1" };
    const m: any = new Projects();
    m.init({}, makeCx());
    expect(m.menuItems()[0].label).toBe("New worktree");
    m.choose(0);
    expect(world.overlays[1]).toEqual(world.overlays[0]);
    expect(world.overlays.some((o) => o.mod === "worktree")).toBe(false);
  });

  test("Create makes the branch with hcoord lane new, then its coordinator in a new space, with no shell space first", async () => {
    const { v } = await start();
    v.newWorktree(p());
    world.calls = [];
    world.answers["lane new"] = made("feature");
    world.answers["lane branches"] = { code: 1, stdout: "", stderr: "hcoord: listing branches: boom\n" }; // Start from is a text box then
    const { d, cx, branch, from } = dialog(world.overlays[0]);
    await cx.settle();
    expect(d.branches).toBe(false);
    branch.text = " feature ";
    from.text = "develop";
    branch.handlers.submit(null, cx); // Enter
    await cx.settle();

    expect(world.calls).toContainEqual(["hcoord", "lane", "new", "feature", "r", "--base", "develop", "--json"]);
    expect(laneOpens()).toEqual([["hcoord", "lane", "open", "/home/.herdr/worktrees/r/feature", "--new-space", "r · feature", "--no-focus", "--json"]]);
    expect(world.runs.some(([name]) => name === "space.new")).toBe(false);
    expect(world.closed).toEqual(["ov1"]);
    expect(d.busyNew).toBe(null);
    expect(world.notes).toHaveLength(0);
  });

  test("it lands on the new space once: hcoord doesn't focus, the dialog closes, then one agent.focus of the new coordinator", async () => {
    world.focused = "s1"; // the project's space, focused when the dialog opened
    world.answers["lane new"] = made("feature");
    world.answers["lane open"] = { code: 0, stdout: JSON.stringify({ project: "r", lane: "feature", ok: true, terminal: "t9", lines: ["started coordinator"] }), stderr: "" };
    const { d, cx, branch } = dialog({ props: { newWorktree: { project: "r", name: "r", defaultBranch: "main" } } });
    branch.text = "feature";
    await d.createWorktree(cx);
    await cx.settle();

    const at = (prefix: string) => world.events.findIndex((e) => e.startsWith(prefix));
    expect(at("hcoord lane open")).toBeGreaterThan(-1);
    expect(at("close ov1")).toBeGreaterThan(at("hcoord lane open"));
    expect(world.events.slice(at("close ov1"))).toEqual(["close ov1", `run agent.focus {"terminal":"t9"}`]);
    // Nothing goes to any other space, the one it was opened from included.
    expect(world.runs.filter(([name]) => name === "space.select" || name === "agent.focus")).toEqual([["agent.focus", { terminal: "t9" }]]);
    expect(world.notes).toHaveLength(0);
  });

  test("if the coordinator couldn't start, the dialog closes without moving the focus and says why", async () => {
    world.answers["lane new"] = made("feature");
    world.answers["lane open"] = { code: 1, stdout: "", stderr: "hcoord: worktree feature is gone\n" };
    const { d, cx, branch } = dialog({ props: { newWorktree: { project: "r", name: "r", defaultBranch: "main" } } });
    branch.text = "feature";
    await d.createWorktree(cx);
    expect(world.closed).toEqual(["ov1"]);
    expect(world.runs).toHaveLength(0);
    expect(world.notes[0]?.body).toContain("is gone");
  });

  test("without a base hcoord picks it; it is busy while it runs and can't be sent twice", async () => {
    world.answers["lane new"] = made("fix");
    const { d, cx, branch } = dialog({ props: { newWorktree: { project: "r", name: "r", defaultBranch: "main" } } });
    branch.text = "fix";
    const running = d.createWorktree(cx);
    expect(d.busyNew).toBeTruthy();
    await d.createWorktree(cx); // a second Enter while busy: ignored
    await running;
    expect(world.calls.filter((c) => c[1] === "lane" && c[2] === "new")).toEqual([["hcoord", "lane", "new", "fix", "r", "--json"]]);
  });

  test("an error shows in the dialog, which stays open; an empty name isn't sent", async () => {
    const { d, cx, branch } = dialog({ props: { newWorktree: { project: "r", name: "r", defaultBranch: "main" } } });
    await d.createWorktree(cx);
    expect(d.error).toContain("Type a name");
    expect(laneNews()).toHaveLength(0);

    world.answers["lane new"] = { code: 1, stdout: "", stderr: "hcoord: branch fix already exists; to open it: hcoord lane checkout fix\n" };
    branch.text = "fix";
    await d.createWorktree(cx);
    expect(d.error).toBe("branch fix already exists; to open it: hcoord lane checkout fix");
    expect(d.busyNew).toBe(null);
    expect(laneOpens()).toHaveLength(0);
    expect(world.closed).toHaveLength(0);

    branch.handlers.change(null, cx); // typing clears it
    expect(d.error).toBe(null);
  });

  const branchList = {
    default: "main",
    selected: "main",
    branches: [
      { name: "alpha", ref: "origin/alpha", remote: true },
      { name: "Beta", ref: "Beta", remote: false },
      { name: "main", ref: "main", remote: false },
      { name: "release/2", ref: "origin/release/2", remote: true },
    ],
  };
  const listed = (list = branchList) => ({ code: 0, stdout: JSON.stringify(list), stderr: "" });

  test("Start from loads the repo's branches when it opens, the default chosen; Create with it leaves the base to hcoord", async () => {
    world.answers["lane branches"] = listed();
    world.answers["lane new"] = made("fix");
    const { d, cx, branch } = dialog({ props: { newWorktree: { project: "r", name: "r", defaultBranch: "main" } } });
    expect(d.branches).toBe(null); // loading
    await cx.settle();
    expect(world.calls).toContainEqual(["hcoord", "lane", "branches", "r", "--json"]);
    expect(d.branches.branches.map((b: any) => b.name)).toEqual(["alpha", "Beta", "main", "release/2"]);
    expect(d.base).toBe("main");
    branch.text = "fix";
    branch.handlers.submit(null, cx); // Enter in the Branch field still creates
    await cx.settle();
    expect(laneNews()).toEqual([["hcoord", "lane", "new", "fix", "r", "--json"]]);
  });

  test("a branch chosen from the list (filtered, ↑ ↓, Enter) is passed as --base, by the ref git resolves", async () => {
    world.answers["lane branches"] = listed();
    world.answers["lane new"] = made("fix");
    const { d, cx, branch, filter } = dialog({ props: { newWorktree: { project: "r", name: "r", defaultBranch: "main" } } });
    await cx.settle();
    const key = (k: string) => d.keyNew({ key: k }, { ...cx, stop_propagation() {} });

    key("down"); // ↓ in the Branch field opens the list, on the chosen branch
    expect(d.picking).toBe(true);
    expect(d.shownBranches()[d.at].ref).toBe("main");
    key("up");
    key("up");
    expect(d.shownBranches()[d.at].ref).toBe("origin/alpha");
    filter.text = "re";
    filter.handlers.change(null, cx);
    expect(d.shownBranches().map((b: any) => b.ref)).toEqual(["origin/release/2"]);
    filter.handlers.submit(null, cx); // Enter in the filter chooses
    expect(d.picking).toBe(false);
    expect(d.base).toBe("origin/release/2");
    expect(filter.text).toBe("");

    branch.text = "fix";
    await d.createWorktree(cx);
    expect(laneNews()).toEqual([["hcoord", "lane", "new", "fix", "r", "--base", "origin/release/2", "--json"]]);
  });

  test("a click on a row chooses it; Esc with the list open closes the list, not the dialog", async () => {
    world.answers["lane branches"] = listed();
    world.answers["lane new"] = made("fix");
    const { d, cx, branch } = dialog({ props: { newWorktree: { project: "r", name: "r", defaultBranch: "main" } } });
    await cx.settle();
    d.openPicker();
    d.keyNew({ key: "escape" }, { ...cx, stop_propagation() {} });
    expect(d.picking).toBe(false);
    expect(world.closed).toEqual([]);
    d.openPicker();
    d.pick(d.branches.branches[1], cx); // Beta, a local branch: its name is its ref
    branch.text = "fix";
    await d.createWorktree(cx);
    expect(laneNews()).toEqual([["hcoord", "lane", "new", "fix", "r", "--base", "Beta", "--json"]]);
    d.keyNew({ key: "escape" }, { ...cx, stop_propagation() {} });
    expect(world.closed).toEqual(["ov1", "ov1"]); // closed once by Create, then by Esc with the list shut
  });

  test("a default branch only on origin is preselected as origin's and still left to hcoord", async () => {
    const list = { default: "main", selected: "origin/main", branches: [{ name: "dev", ref: "dev", remote: false }, { name: "main", ref: "origin/main", remote: true }] };
    world.answers["lane branches"] = listed(list);
    world.answers["lane new"] = made("fix");
    const { d, cx, branch } = dialog({ props: { newWorktree: { project: "r", name: "r", defaultBranch: "main" } } });
    await cx.settle();
    expect(d.base).toBe("origin/main");
    branch.text = "fix";
    await d.createWorktree(cx);
    expect(laneNews()).toEqual([["hcoord", "lane", "new", "fix", "r", "--json"]]);
  });

  test("going to a worktree with no space opens its coordinator in a new space rather than space.new", async () => {
    world.board = project(["/r", "/home/wt/feature"]);
    const { v, cx } = await start();
    const w = v.worktrees(p()).find((x: any) => x.path === "/home/wt/feature");
    await v.go(p(), w, cx);
    expect(world.runs.some(([name]) => name === "space.new")).toBe(false);
    expect(laneOpens()).toEqual([["hcoord", "lane", "open", "/home/wt/feature", "--new-space", "r · feature"]]);
  });
});
