// The sidebar mod (mods/hcoord/main.js) runs inside Herdr; here it's loaded with stand-ins for Herdr's
// modules so its refresh and follow-the-space logic can be checked without the app.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers.ts";
import { byId, el, textOf, walk } from "./mod-stand-ins.ts";

// A copy of the mod beside the hcoord-path.js that `hcoord mod install` would write.
const SOURCE = join(import.meta.dir, "..", "mods", "hcoord");
const MOD = tempDir("mod");
copyFileSync(join(SOURCE, "main.js"), join(MOD, "main.js"));
writeFileSync(join(MOD, "hcoord-path.js"), 'export const HCOORD = ["hcoord"];\n');
// And a plain copy of the folder, as Herdr's gallery makes: nothing has set hcoord up.
const COPY = tempDir("mod-copy");
for (const f of ["main.js", "hcoord-path.js"]) copyFileSync(join(SOURCE, f), join(COPY, f));

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
  /** Set: exec of hcoord fails with this, as when its program is gone. */
  execError: null as Error | null,
  layout: null as any,
  picked: 0,
  /** Set: `lane open` waits for this, so a test can see what's happening while one runs. */
  hold: null as Promise<void> | null,
};

/** A stand-in text field: a value, and handlers the test can fire. */
class FakeInput {
  text: string;
  handlers: any = {};
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

mock.module("gpui-kit", () => ({ View: class {}, div: el, svg: el }));
mock.module("gpui-base", () => ({ v_flex: el, h_flex: el, TextView: class {}, InputState: FakeInput, Input: { new: () => ({}) }, Scrollbar: { vertical: () => ({}) } }));
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
    if (world.execError && cmd !== "git") throw world.execError;
    if (world.hold && args[0] === "lane" && args[1] === "open") await world.hold;
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
  pickFolder: async () => (world.picked++, null),
  watchFolder: () => new Promise(() => {}),
  layout: () => world.layout,
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
const { default: PlainCopy } = await import(join(COPY, "main.js"));

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
  world.execError = null;
  world.picked = 0;
  world.layout = null;
  world.hold = null;
  inputs.length = 0;
});

async function start(View: any = Projects) {
  const cx = makeCx();
  const v: any = new View();
  v.init({}, cx);
  await cx.settle();
  return { v, cx };
}

describe("when the CLI can't be run", () => {
  const URL = "https://github.com/jonathan-fielding/herdr-project-coordinator";
  const fireTimers = async (cx: any) => {
    for (const t of world.timers) t.fn(cx);
    await cx.settle();
  };
  const hcoordCalls = () => world.calls.filter((c) => c[0] !== "git");
  const expectNotice = (v: any, cx: any) => {
    const tree = v.render(cx);
    expect(textOf(tree)).toContain("needs hcoord's CLI");
    expect(textOf(tree)).toContain(URL);
    expect(textOf(tree)).not.toContain("hcoord:"); // the error line
    expect(walk(tree).some((e) => e?.elementId === "hc-new")).toBe(false); // nothing to make a project with
    return tree;
  };

  test("a plain copy shows the not-set-up state and never tries to run anything", async () => {
    const { v, cx } = await start(PlainCopy);
    await fireTimers(cx);
    v.refresh(cx);
    await cx.settle();
    const tree = expectNotice(v, cx);
    expect(world.calls).toEqual([]);
    expect(world.notes).toEqual([]);
    let opened = "";
    walk(tree).find((e) => e?.elementId === "hc-setup").click(null, { open_url: (u: string) => (opened = u) });
    expect(opened).toBe(URL);
  });

  test("the narrow rail says it too, in place of the new project button", async () => {
    world.layout = { id: "sidebar", size: { px: 44 } };
    const { v, cx } = await start(PlainCopy);
    const tree = v.render(cx);
    expect(walk(tree).some((e) => e?.elementId === "hc-setup")).toBe(true);
    expect(walk(tree).some((e) => e?.elementId === "hc-new")).toBe(false);
  });

  test("the new project command does nothing, rather than ask for a folder it can't use", async () => {
    const { v, cx } = await start(PlainCopy);
    await v.newProject(cx);
    expect(world.picked).toBe(0);
  });

  test("exec failing shows the same state, quietly, and is tried again now and then until it works", async () => {
    world.execError = new Error("No such file or directory");
    const { v, cx } = await start();
    expectNotice(v, cx);
    expect(hcoordCalls()).toHaveLength(1);
    expect(world.notes).toEqual([]);

    await fireTimers(cx); // the 8s fallback doesn't try every time
    v.refresh(cx);
    await cx.settle();
    expect(hcoordCalls()).toHaveLength(1);

    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 61000;
      await fireTimers(cx);
      expect(hcoordCalls()).toHaveLength(2); // still failing: quiet
      expectNotice(v, cx);

      world.execError = null;
      Date.now = () => realNow() + 122000;
      await fireTimers(cx);
    } finally {
      Date.now = realNow;
    }
    expect(v.notSetUp).toBe(false);
    expect(textOf(v.render(cx))).not.toContain("needs hcoord's CLI");
    expect(walk(v.render(cx)).some((e) => e?.elementId === "hc-new")).toBe(true);
  });

  for (const [what, code, stderr] of [
    ["bun has gone", 127, "env: bun: No such file or directory"],
    ["the clone holding cli.ts has moved", 1, 'error: Module not found "/old/src/cli.ts"'],
  ] as const) {
    test(`${what} counts too`, async () => {
      world.answers["board --json"] = { code, stdout: "", stderr };
      const { v, cx } = await start();
      expectNotice(v, cx);
    });
  }

  test("a board command that ran and failed is still an error, shown as one", async () => {
    world.answers["board --json"] = { code: 1, stdout: "", stderr: "hcoord: tasks.json is broken" };
    const { v, cx } = await start();
    expect(v.notSetUp).toBe(false);
    expect(textOf(v.render(cx))).toContain("tasks.json is broken");
    expect(textOf(v.render(cx))).not.toContain("needs hcoord's CLI");
  });
});

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

describe("coordinators a restart stopped", () => {
  const STOPPED = "Stopped by a restart: click to bring back";
  const OCCUPIED = "Something else is running in its terminal: exit it first";
  const PLAIN_CLAUDE = "Plain Claude running, not the coordinator";
  const NO_STATUS = "Coordinator reports no status: look at it";

  /** A board whose worktrees have coordinators in these states (`/r` is the main checkout), their terminals live. */
  function coordinators(states: Record<string, string>) {
    const paths = Object.keys(states);
    const lanes = paths.map((path, i) => ({
      key: base(path),
      path,
      branch: base(path),
      present: true,
      coordinator: { address: `t${i}`, name: `coord-${i}`, session: `session-${i}` },
      coordinatorState: states[path],
    }));
    world.board = project(paths, lanes);
    world.terminals = lanes.map((l) => ({ address: l.coordinator.address, name: l.coordinator.name, state: "live" }));
    return lanes;
  }
  const p = () => world.board.projects[0];
  const tree = (v: any, cx: any) => v.render(cx);
  const head = (v: any, cx: any, path: string) => byId(tree(v, cx), `wt-${path}`);
  const click = async (e: any, cx: any) => {
    e.click({}, cx);
    await cx.settle();
  };
  const focusMoves = () => world.runs.filter(([name]) => name === "space.select" || name === "agent.focus");
  const laneSays = () => world.calls.filter((c) => c[1] === "lane" && c[2] === "say");
  const later = async (ms: number, fn: () => Promise<void> | void) => {
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + ms;
      await fn();
    } finally {
      Date.now = realNow;
    }
  };

  describe("shell", () => {
    test("says it's stopped, with a mark and a tooltip, and no ? badge or prompt row", async () => {
      coordinators({ "/r": "shell" });
      const { v, cx } = await start();
      const t = tree(v, cx);
      expect(textOf(t)).toContain(STOPPED);
      expect(textOf(t)).not.toContain("?");
      expect(textOf(t)).not.toContain(NO_STATUS);
      expect(byId(t, "restartbtn-/r")).toBeUndefined();
      expect(byId(t, "stopped-/r").tip).toContain("carrying on its conversation");
      expect(head(v, cx, "/r").tip).toContain("carrying on its conversation");
      expect(walk(t).some((e) => e?.args?.[0] === "mods/workspace-chrome/square.svg")).toBe(true);
    });

    test("doesn't promise a conversation it hasn't got", async () => {
      const [l] = coordinators({ "/r": "shell" });
      delete (l!.coordinator as any).session;
      const { v, cx } = await start();
      expect(byId(tree(v, cx), "stopped-/r").tip).toContain("new conversation");
    });

    test("shows on a folded worktree too", async () => {
      coordinators({ "/r": "shell", "/home/wt/a": "running" });
      const { v, cx } = await start();
      v.open["w:/r"] = false;
      expect(textOf(tree(v, cx))).toContain(STOPPED);
    });

    test("clicking the worktree resumes it in its space, with no error", async () => {
      coordinators({ "/r": "shell" });
      const { v, cx } = await start();
      await click(head(v, cx, "/r"), cx);
      expect(laneOpens()).toEqual([["hcoord", "lane", "open", "/r", "--space", "s1"]]);
      expect(world.notes).toEqual([]);
    });

    test("clicking the line does the same", async () => {
      coordinators({ "/r": "shell" });
      const { v, cx } = await start();
      await click(byId(tree(v, cx), "stopped-/r"), cx);
      expect(laneOpens()).toEqual([["hcoord", "lane", "open", "/r", "--space", "s1"]]);
    });

    test("an agent Herdr reports in that terminal doesn't count: it still resumes, rather than focus it", async () => {
      coordinators({ "/r": "shell" });
      world.agents = [{ address: "t0", space: "s1", status: "idle" }];
      const { v, cx } = await start();
      await click(head(v, cx, "/r"), cx);
      expect(laneOpens()).toHaveLength(1);
      expect(world.runs.some(([name]) => name === "agent.focus")).toBe(false);
    });

    test("it resumes in the space still holding its pane, wherever that is", async () => {
      coordinators({ "/r": "running", "/home/wt/a": "shell" });
      world.spaces.push({ id: "s2", folder: "/elsewhere", tabs: [{ id: "tab2" }] });
      world.panes = [{ pane: "p1", terminal: "t1", tab: "tab2", cwd: "/elsewhere" }];
      const { v, cx } = await start();
      await click(head(v, cx, "/home/wt/a"), cx);
      expect(laneOpens()).toEqual([["hcoord", "lane", "open", "/home/wt/a", "--space", "s2"]]);
    });

    test("switching to its space resumes it, once a minute at most", async () => {
      coordinators({ "/r": "running", "/home/wt/a": "shell" });
      world.agents = [{ address: "t0", space: "s1", status: "idle" }];
      world.spaces.push({ id: "s2", folder: "/home/wt/a", tabs: [] });
      const { v, cx } = await start();
      const go = async (space: string) => {
        world.focused = space;
        v.followSpace(cx);
        await cx.settle();
      };
      await go("s2");
      expect(laneOpens()).toEqual([["hcoord", "lane", "open", "/home/wt/a", "--space", "s2"]]);
      expect(world.notes).toEqual([]);
      expect(focusMoves()).toEqual([]);

      await go("s1");
      await go("s2"); // back within the minute: still stopped on the board, left alone
      expect(laneOpens()).toHaveLength(1);

      await later(61000, async () => {
        await go("s1");
        await go("s2");
      });
      expect(laneOpens()).toHaveLength(2);
    });

    test("switching there keeps the space's name if replacing it closes the space", async () => {
      coordinators({ "/r": "running", "/home/wt/a": "shell" });
      world.spaces.push({ id: "s2", folder: "/home/wt/a", name: "r · a", named: true, tabs: [] });
      const { v, cx } = await start();
      let release = () => {};
      world.hold = new Promise((r) => (release = r));
      world.focused = "s2";
      v.followSpace(cx);
      await cx.settle();
      world.spaces[1] = { id: "s2", folder: "/home/wt/a", name: "a", named: false, tabs: [] };
      release();
      world.hold = null;
      await cx.settle();
      expect(world.runs).toContainEqual(["space.rename", { id: "s2", name: "r · a" }]);
    });

    test("and its place in the list", async () => {
      coordinators({ "/r": "running", "/home/wt/a": "shell" });
      const moved = { id: "s2", folder: "/home/wt/a", tabs: [] };
      world.spaces.unshift(moved);
      world.focused = "s1";
      const { v, cx } = await start();
      let release = () => {};
      world.hold = new Promise((r) => (release = r));
      world.focused = "s2";
      v.followSpace(cx);
      await cx.settle();
      world.spaces.reverse(); // made again, last
      release();
      world.hold = null;
      await cx.settle();
      expect(world.runs).toContainEqual(["space.move", { id: "s2", index: 1 }]);
    });

    test("the focus landing elsewhere while one is replaced doesn't resume that space's coordinator too", async () => {
      coordinators({ "/r": "shell", "/home/wt/a": "shell" });
      world.spaces.push({ id: "s2", folder: "/home/wt/a", tabs: [] });
      world.focused = "s2";
      const { v, cx } = await start();
      let release = () => {};
      world.hold = new Promise((r) => (release = r));
      await new Promise<void>((done) => {
        head(v, cx, "/home/wt/a").click({}, cx);
        cx.settle().then(done);
      });
      world.focused = "s1"; // s2 closed, as its only tab was replaced
      v.followSpace(cx);
      await cx.settle();
      world.focused = "s2"; // hcoord focuses the new coordinator
      v.followSpace(cx);
      release();
      world.hold = null;
      await cx.settle();
      expect(laneOpens().map((c) => c[3])).toEqual(["/home/wt/a"]);
    });

    test("Raise PR goes through lane say, which resumes it: the shell isn't focused or typed at here", async () => {
      coordinators({ "/r": "running", "/home/wt/a": "shell" });
      world.board.projects[0].defaultBranch = { name: "main", path: "/r", checkedOut: true };
      world.agents = [{ address: "t1", space: "s1", status: "idle" }]; // stale: mustn't look like a running coordinator
      world.spaces.push({ id: "s2", folder: "/home/wt/a", tabs: [] });
      const { v, cx } = await start();
      const w = v.worktrees(p()).find((x: any) => x.path === "/home/wt/a");
      await v.raisePr(p(), w, cx);
      expect(laneSays()).toHaveLength(1);
      expect(laneSays()[0]!.slice(0, 4)).toEqual(["hcoord", "lane", "say", "/home/wt/a"]);
      expect(world.runs.some(([name]) => name === "agent.focus")).toBe(false);
      expect(world.notes.map((n) => n.level)).toEqual(["info"]);
    });

    test("Raise PR with no space for it makes one, as a click would", async () => {
      coordinators({ "/r": "running", "/home/wt/a": "shell" });
      world.board.projects[0].defaultBranch = { name: "main", path: "/r", checkedOut: true };
      const { v, cx } = await start();
      const w = v.worktrees(p()).find((x: any) => x.path === "/home/wt/a");
      await v.raisePr(p(), w, cx);
      expect(laneSays()[0]!.slice(-2)).toEqual(["--new-space", "r · a"]);
    });
  });

  describe("nothing resumes by itself", () => {
    test("not on load, however often the sidebar redraws or refreshes", async () => {
      coordinators({ "/r": "shell", "/home/wt/a": "shell" });
      const { v, cx } = await start();
      tree(v, cx);
      for (const t of world.timers) t.fn(cx);
      await cx.settle();
      tree(v, cx);
      await later(61000, async () => {
        for (const t of world.timers) t.fn(cx);
        await cx.settle();
        tree(v, cx);
        await cx.settle();
      });
      expect(laneOpens()).toEqual([]);
      expect(laneSays()).toEqual([]);
    });

    test("not when Herdr's focus only arrives after the mod has loaded", async () => {
      coordinators({ "/r": "shell" });
      world.focused = null;
      const { v, cx } = await start();
      world.focused = "s1";
      tree(v, cx);
      await cx.settle();
      v.refresh(cx);
      await cx.settle();
      expect(laneOpens()).toEqual([]);
    });

    test("not when that space is only known once the board has loaded", async () => {
      coordinators({ "/r": "shell" });
      world.focused = null;
      const cx = makeCx();
      const v: any = new Projects();
      const board = world.board;
      world.board = project([]);
      v.init({}, cx);
      await cx.settle();
      world.focused = "s1";
      v.followSpace(cx);
      expect(v.pendingSpace).toBe("s1");
      world.board = board;
      v.refresh(cx);
      await cx.settle();
      expect(laneOpens()).toEqual([]);
    });

    test("but going back to the space Herdr came up on is a switch", async () => {
      coordinators({ "/r": "shell" });
      world.focused = null;
      world.spaces.push({ id: "s2", folder: "/home", tabs: [] });
      const { v, cx } = await start();
      for (const space of ["s1", "s2", "s1"]) {
        world.focused = space;
        v.followSpace(cx);
        await cx.settle();
      }
      expect(laneOpens()).toHaveLength(1);
    });
  });

  describe("occupied", () => {
    test("has its own line, with no replace button and no ? badge", async () => {
      coordinators({ "/r": "occupied" });
      const { v, cx } = await start();
      const t = tree(v, cx);
      expect(textOf(t)).toContain(OCCUPIED);
      expect(textOf(t)).not.toContain(STOPPED);
      expect(textOf(t)).not.toContain(NO_STATUS);
      expect(textOf(t)).not.toContain("?");
      expect(byId(t, "restartbtn-/r")).toBeUndefined();
      expect(byId(t, "occupied-/r").tip).toContain("Exit it first");
    });

    describe("says what's there", () => {
      /** The occupied line and worktree tooltip for this program, the lane with or without a saved session. */
      async function shown(program: string | null | undefined, session = true) {
        const [lane] = coordinators({ "/r": "occupied" });
        if (program !== undefined) (lane as any).coordinatorProgram = program;
        if (!session) delete (lane as any).coordinator.session;
        const { v, cx } = await start();
        const t = tree(v, cx);
        return { text: textOf(t), tip: byId(t, "occupied-/r").tip as string, head: byId(t, "wt-/r").tip as string };
      }

      test("Claude with a saved session: that conversation comes back, not this one", async () => {
        const { text, tip, head } = await shown("claude");
        expect(text).toContain(PLAIN_CLAUDE);
        expect(text).not.toContain(OCCUPIED);
        expect(tip).toContain("started by hand and isn't the coordinator");
        expect(tip).toContain("/exit it, then click the worktree");
        expect(tip).toContain("saved conversation comes back, not this session, which stays in its own transcript");
        expect(head).toContain(tip);
      });

      test("Claude with no saved session: a new conversation", async () => {
        const { text, tip } = await shown("claude", false);
        expect(text).toContain(PLAIN_CLAUDE);
        expect(tip).toContain("/exit it");
        expect(tip).toContain("starts a new conversation");
        expect(tip).not.toContain("saved conversation");
      });

      for (const session of [true, false]) {
        test(`another program is named${session ? "" : ", no saved session"}`, async () => {
          const { text, tip } = await shown("vim", session);
          expect(text).toContain("vim running, not the coordinator");
          expect(text).not.toContain("Claude");
          expect(tip).toContain("vim is running in the coordinator's terminal");
          expect(tip).toContain("Exit it first");
          expect(tip).not.toContain("conversation");
        });

        test(`unknown foreground keeps the generic line${session ? "" : ", no saved session"}`, async () => {
          const { text, tip } = await shown(null, session);
          expect(text).toContain(OCCUPIED);
          expect(tip).toContain("Something else is running");
          expect(tip).toContain("Exit it first");
        });
      }

      test("a board from an older hcoord, with no such field: the generic line", async () => {
        expect((await shown(undefined)).text).toContain(OCCUPIED);
      });
    });

    test("a click, on the line or the worktree, peeks and starts nothing", async () => {
      coordinators({ "/r": "occupied" });
      const { v, cx } = await start();
      await click(byId(tree(v, cx), "occupied-/r"), cx);
      await click(head(v, cx, "/r"), cx);
      expect(world.runs).toEqual([["terminal.peek", { terminal: "t0" }], ["terminal.peek", { terminal: "t0" }]]);
      expect(laneOpens()).toEqual([]);
      expect(world.notes).toEqual([]);
    });

    test("a Claude started by hand there doesn't count as the coordinator", async () => {
      coordinators({ "/r": "occupied" });
      world.agents = [{ address: "t0", space: "s1", status: "working" }];
      const { v, cx } = await start();
      expect(textOf(tree(v, cx))).toContain(OCCUPIED);
      await click(head(v, cx, "/r"), cx);
      expect(world.runs).toEqual([["terminal.peek", { terminal: "t0" }]]);
    });

    test("switching to its space leaves it alone", async () => {
      coordinators({ "/r": "running", "/home/wt/a": "occupied" });
      world.spaces.push({ id: "s2", folder: "/home/wt/a", tabs: [] });
      const { v, cx } = await start();
      world.focused = "s2";
      v.followSpace(cx);
      await cx.settle();
      expect(laneOpens()).toEqual([]);
      expect(world.runs).toEqual([]);
    });

    test("Raise PR leaves the refusing to hcoord, whose message names what's running", async () => {
      coordinators({ "/r": "running", "/home/wt/a": "occupied" });
      world.board.projects[0].defaultBranch = { name: "main", path: "/r", checkedOut: true };
      world.answers["lane say"] = { code: 1, stdout: "", stderr: "`vim` is running in coord-1 (t1), not the coordinator. hcoord won't stop it.\n" };
      const { v, cx } = await start();
      const w = v.worktrees(p()).find((x: any) => x.path === "/home/wt/a");
      await v.raisePr(p(), w, cx);
      expect(world.notes.map((n) => n.level)).toEqual(["error"]);
      expect(world.notes[0].body).toContain("vim");
    });

    test("isn't counted as stopped", async () => {
      coordinators({ "/r": "occupied", "/home/wt/a": "occupied", "/home/wt/b": "shell" });
      const { v, cx } = await start();
      expect(textOf(tree(v, cx))).not.toContain("coordinators stopped");
    });
  });

  describe("prompt", () => {
    test("keeps its row and replace button", async () => {
      coordinators({ "/r": "prompt" });
      const { v, cx } = await start();
      const t = tree(v, cx);
      expect(textOf(t)).toContain(NO_STATUS);
      expect(textOf(t)).toContain("?");
      expect(textOf(t)).not.toContain(STOPPED);
      await click({ click: (e: any, c: any) => byId(t, "restartbtn-/r").click({ ...e }, { ...c, stop_propagation() {} }) }, cx);
      expect(laneOpens()).toEqual([["hcoord", "lane", "open", "/r", "--space", "s1", "--restart"]]);
    });

    test("the row's click peeks", async () => {
      coordinators({ "/r": "prompt" });
      const { v, cx } = await start();
      await click(byId(tree(v, cx), "restart-/r"), cx);
      expect(world.runs).toEqual([["terminal.peek", { terminal: "t0" }]]);
    });

    test("goes by the board even if Herdr reports an agent there", async () => {
      coordinators({ "/r": "prompt" });
      world.agents = [{ address: "t0", space: "s1", status: "unknown" }];
      const { v, cx } = await start();
      expect(textOf(tree(v, cx))).toContain(NO_STATUS);
    });

    test("isn't brought back by switching to it", async () => {
      coordinators({ "/r": "running", "/home/wt/a": "prompt" });
      world.spaces.push({ id: "s2", folder: "/home/wt/a", tabs: [] });
      const { v, cx } = await start();
      world.focused = "s2";
      v.followSpace(cx);
      await cx.settle();
      expect(laneOpens()).toEqual([]);
    });
  });

  describe("the bring-back line", () => {
    const line = (v: any, cx: any) => byId(tree(v, cx), "bring-back-r");
    const three = { "/r": "shell", "/home/wt/a": "shell", "/home/wt/b": "running" };

    test("shows for more than one, counting only the stopped", async () => {
      coordinators(three);
      const { v, cx } = await start();
      expect(textOf(line(v, cx))).toContain("2 coordinators stopped: bring back");
    });

    test("doesn't show for one", async () => {
      coordinators({ "/r": "shell", "/home/wt/a": "running" });
      const { v, cx } = await start();
      expect(line(v, cx)).toBeUndefined();
    });

    test("leaves out a worktree that's gone", async () => {
      coordinators({ "/r": "shell", "/home/wt/a": "shell" });
      const [, gone] = p().lanes;
      gone.present = false;
      p().checkouts = p().checkouts.filter((c: any) => c.path === "/r");
      p().tasks = [{ id: "T-1", lane: gone.key, state: "working", waitingOn: [] }];
      const { v, cx } = await start();
      expect(line(v, cx)).toBeUndefined();
      expect(textOf(tree(v, cx))).not.toContain(`${STOPPED} ${STOPPED}`);
    });

    test("a folded project opens to show it, unless the person folded it", async () => {
      coordinators({ "/r": "shell", "/home/wt/a": "shell" });
      world.board.projects.push({ ...p(), slug: "other", lanes: [], checkouts: [] }); // so it isn't the only project
      world.focused = null;
      const { v, cx } = await start();
      expect(line(v, cx)).toBeTruthy();
      v.open["p:r"] = false;
      expect(line(v, cx)).toBeUndefined();
    });

    test("one click resumes each in turn, without moving the focus", async () => {
      coordinators(three);
      world.spaces.push({ id: "s2", folder: "/home/wt/a", tabs: [] });
      let release = () => {};
      world.hold = new Promise((r) => (release = r));
      const { v, cx } = await start();
      line(v, cx).click({}, cx);
      await cx.settle();
      expect(laneOpens()).toHaveLength(1); // the second waits for the first
      expect(textOf(line(v, cx))).toContain("Bringing coordinators back");
      release();
      world.hold = null;
      await cx.settle();
      expect(laneOpens()).toEqual([
        ["hcoord", "lane", "open", "/r", "--space", "s1", "--no-focus", "--json"],
        ["hcoord", "lane", "open", "/home/wt/a", "--space", "s2", "--no-focus", "--json"],
      ]);
      expect(world.runs).toEqual([]);
      expect(world.notes).toEqual([]);
    });

    test("if bringing back the focused space closes it for a moment, the person is put back", async () => {
      coordinators({ "/r": "shell", "/home/wt/a": "shell" });
      world.answers["lane open"] = { code: 0, stdout: JSON.stringify({ terminal: "t9", lines: [] }), stderr: "" };
      world.spaces.push({ id: "s2", folder: "/home", tabs: [] });
      const { v, cx } = await start();
      let release = () => {};
      world.hold = new Promise((r) => (release = r));
      line(v, cx).click({}, cx);
      await cx.settle();
      world.focused = "s2"; // Herdr, as the only tab in s1 closes
      v.followSpace(cx);
      await cx.settle();
      expect(laneOpens()).toHaveLength(1); // landing there started nothing
      release();
      world.hold = null;
      await cx.settle();
      expect(world.runs).toEqual([["agent.focus", { terminal: "t9" }]]);
    });

    test("focus isn't touched when it stayed put", async () => {
      coordinators({ "/r": "shell", "/home/wt/a": "shell" });
      world.answers["lane open"] = { code: 0, stdout: JSON.stringify({ terminal: "t9", lines: [] }), stderr: "" };
      const { v, cx } = await start();
      await click(line(v, cx), cx);
      expect(world.runs).toEqual([]);
    });

    test("a named space that was closed and made again gets its name back", async () => {
      coordinators({ "/r": "running", "/home/wt/a": "shell", "/home/wt/b": "shell" });
      world.spaces.push({ id: "s2", folder: "/home/wt/a", name: "r · a", named: true, tabs: [] });
      world.spaces.push({ id: "s3", folder: "/home/wt/b", name: "mine", named: true, tabs: [] });
      const { v, cx } = await start();
      let release = () => {};
      world.hold = new Promise((r) => (release = r));
      line(v, cx).click({}, cx);
      await cx.settle();
      world.spaces[1] = { id: "s2", folder: "/home/wt/a", name: "a", named: false, tabs: [] };
      release();
      world.hold = null;
      await cx.settle();
      expect(world.runs).toEqual([["space.rename", { id: "s2", name: "r · a" }]]); // s3 kept its name
    });

    test("one with no space gets a new one, still without the focus moving", async () => {
      coordinators({ "/r": "shell", "/home/wt/a": "shell" });
      const { v, cx } = await start();
      await click(line(v, cx), cx);
      expect(laneOpens()[1]).toEqual(["hcoord", "lane", "open", "/home/wt/a", "--new-space", "r · a", "--no-focus", "--json"]);
      expect(world.runs).toEqual([]);
    });

    test("a second click while it runs does nothing", async () => {
      coordinators(three);
      let release = () => {};
      world.hold = new Promise((r) => (release = r));
      const { v, cx } = await start();
      const l = line(v, cx);
      l.click({}, cx);
      l.click({}, cx);
      await cx.settle();
      release();
      world.hold = null;
      await cx.settle();
      expect(laneOpens()).toHaveLength(2);
    });

    test("one that fails says so, and the rest still come back", async () => {
      coordinators(three);
      world.answers["lane open"] = { code: 1, stdout: "", stderr: "hcoord: nope\n" };
      const { v, cx } = await start();
      await click(line(v, cx), cx);
      expect(laneOpens()).toHaveLength(2);
      expect(world.notes).toHaveLength(2);
      expect(world.notes[0].title).toContain("Couldn't bring back");
      expect(v.bringing.size).toBe(0);
      expect(v.busy.size).toBe(0);
    });

    test("the count follows the board as they come back", async () => {
      coordinators(three);
      const { v, cx } = await start();
      await click(line(v, cx), cx);
      expect(world.boardRuns).toBeGreaterThan(1);
      coordinators({ "/r": "running", "/home/wt/a": "running", "/home/wt/b": "running" });
      v.refresh(cx);
      await cx.settle();
      expect(line(v, cx)).toBeUndefined();
    });
  });

  test("a board without the state (an older CLI) works as before", async () => {
    const [l] = coordinators({ "/r": "running" });
    delete (l as any).coordinatorState;
    const { v, cx } = await start();
    expect(textOf(tree(v, cx))).toContain(NO_STATUS);
    expect(textOf(tree(v, cx))).not.toContain(STOPPED);
  });
});
