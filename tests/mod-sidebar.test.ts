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
};

mock.module("gpui-kit", () => ({ View: class {}, div: () => ({}), svg: () => ({}) }));
mock.module("gpui-base", () => ({ v_flex: () => ({}), h_flex: () => ({}), TextView: class {} }));
mock.module("herdr", () => ({
  agents: () => world.agents,
  terminals: () => world.terminals,
  panes: () => world.panes,
  spaces: () => world.spaces,
  focused: () => (world.focused ? { space: world.focused } : null),
  run: () => {},
  exec: async (cmd: string, args: string[]) => {
    world.calls.push([cmd, ...args]);
    if (args[0] === "board") {
      world.boardRuns++;
      return { code: 0, stdout: JSON.stringify(world.board), stderr: "" };
    }
    if (cmd === "git") return { code: 0, stdout: "/r/.git\n", stderr: "" };
    return { code: 0, stdout: "{}", stderr: "" };
  },
  theme: () => ({}),
  notify: () => {},
  nextCommand: () => new Promise(() => {}),
  pickFolder: async () => null,
  watchFolder: () => new Promise(() => {}),
  layout: () => null,
  home: () => "/home",
  props: () => ({}),
  openOverlay: () => {},
  closeOverlay: () => {},
}));
(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {} };

const { default: Projects } = await import(join(MOD, "main.js"));

/** A stand-in cx. Some spawned tasks never end (the folder watch, the command loop), so settle()
 *  just lets the stand-in calls, which answer at once, run through. */
function makeCx() {
  const cx: any = {
    spawn: (fn: (cx: any) => Promise<unknown>) => void Promise.resolve().then(() => fn(cx)),
    notify: () => {},
    timer: { every: (ms: number, fn: (cx: any) => void) => world.timers.push({ ms, fn }) },
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
