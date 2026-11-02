/**
 * Integration tests for workers against a private herdr-core, with a shell script standing in for
 * the agent (tests/fixtures/fake-worker.sh), so they spend no tokens.
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "../src/model.ts";
import { TestCore } from "./hccore.ts";
import { CLI, cli, tempDir, tempRepo } from "./helpers.ts";

const FAKE = join(import.meta.dir, "fixtures", "fake-worker.sh");
const core = new TestCore();
beforeAll(() => core.start());
afterAll(() => core.stop());

let home: string;
let repo: string;
let coord: string; // stand-in coordinator terminal: appends whatever is typed into it to `inbox`
let inbox: string;
let n = 0;

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
}

function setup(maxParallel: number) {
  home = tempDir("home");
  repo = tempRepo("app");
  writeFileSync(join(repo, "README.md"), "app\n");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ version: 1, agent: { kind: "generic", command: ["sh", FAKE] }, worktreeRoot: join(home, "wt"), maxParallel }),
  );
  inbox = join(home, "inbox.txt");
  coord = core.hc("run", "--bg", "--name", `coord-${++n}`, "--", "sh", "-c", `cat >> '${inbox}'`).address;
}

beforeEach(() => {});
afterEach(() => {
  // Stop every worker this test started, then drop its files.
  for (const t of core.hc("ls", "--label", "hcoord.project=demo").terminals ?? []) core.hc("kill", t.address);
  try {
    core.hc("kill", coord);
  } catch {}
  for (const d of [home, repo]) rmSync(d, { recursive: true, force: true });
});

const hcoord = async (...args: string[]) => {
  const r = await cli(home, args, undefined, core.env);
  return { ...r, out: r.stdout + r.stderr };
};
const ok = async (...args: string[]) => {
  const r = await hcoord(...args);
  if (r.code !== 0) throw new Error(`hcoord ${args.join(" ")} → ${r.code}:\n${r.out}`);
  return r.stdout;
};

const tasks = (): Task[] => JSON.parse(readFileSync(join(home, "projects", "demo", "tasks.json"), "utf8")).tasks;
const task = (id: string) => tasks().find((t) => t.id === id)!;
const states = () => Object.fromEntries(tasks().map((t) => [t.id, t.state]));

async function until(what: string, pred: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; states: ${JSON.stringify(states())}`);
    await Bun.sleep(100);
  }
}

/** A brief that steers the fake worker. */
function brief(lines: Record<string, string>): string {
  const all = { BUN: process.execPath, CLI, HCOORD_HOME: home, ...lines };
  return ["Do the thing.", ...Object.entries(all).map(([k, v]) => `${k}=${v}`)].join("\n");
}

async function addTask(title: string, b: Record<string, string>, ...extra: string[]) {
  return (await ok("task", "add", "demo", "--title", title, "--brief", brief(b), ...extra)).trim();
}

describe("workers", () => {
  test("three run in parallel worktrees, report back, and a queued fourth starts when a slot frees", async () => {
    setup(3);
    await ok("project", "new", "demo", "--repo", repo, "--prefix", "DM");
    for (let i = 1; i <= 4; i++) await addTask(`Job ${i}`, { GATE: join(home, `gate-${i}`) });

    for (let i = 1; i <= 3; i++) expect(await ok("task", "start", `DM-${i}`, "--parent", coord)).toContain(`started DM-${i}: w-dm-${i}`);
    expect(await ok("task", "start", "DM-4", "--parent", coord)).toContain("DM-4 queued: all 3 worker slots are busy");
    expect(states()).toEqual({ "DM-1": "working", "DM-2": "working", "DM-3": "working", "DM-4": "queued" });

    // Each worker: its own worktree on its own branch, labelled, outliving its parent, reporting to coord.
    for (let i = 1; i <= 3; i++) {
      const t = task(`DM-${i}`);
      expect(t.worktree).toBe(join(home, "wt", "demo", `dm-${i}`));
      expect(git(t.worktree!, "branch", "--show-current")).toBe(`coord/dm-${i}-job-${i}`);
      const h = core.hc("get", t.terminal!.address);
      expect(h).toMatchObject({ name: `w-dm-${i}`, state: "live", parent: coord, die_with_parent: false });
      expect(h.argv.at(-1)).toContain(`Task: DM-${i} Job ${i}`); // the brief is the last argument

      expect(h.labels).toMatchObject({ "hcoord.project": "demo", "hcoord.task": `DM-${i}` });
    }

    writeFileSync(join(home, "gate-1"), "");
    await until("DM-1 done and DM-4 started", () => task("DM-1").state === "done" && task("DM-4").state === "working");
    // Started by DM-1's report (run inside DM-1's terminal), yet its parent is the coordinator.
    expect(core.hc("get", task("DM-4").terminal!.address).parent).toBe(coord);

    for (const i of [2, 3, 4]) writeFileSync(join(home, `gate-${i}`), "");
    await until("all done", () => tasks().every((t) => t.state === "done"));

    for (let i = 1; i <= 4; i++) {
      const t = task(`DM-${i}`);
      expect(t.summary).toBe(`Wrote work-DM-${i}.txt.`);
      expect(readFileSync(join(home, "projects", "demo", "reports", `DM-${i}.md`), "utf8")).toContain("Tested: nothing to test.");
      expect(git(repo, "log", "--format=%s", t.branch)).toContain(`DM-${i}: fake work`);
    }
    await until("4 notes in the coordinator's inbox", () => existsSync(inbox) && readFileSync(inbox, "utf8").trim().split("\n").length >= 4);
    const notes = readFileSync(inbox, "utf8").trim().split("\n").sort();
    expect(notes).toHaveLength(4);
    for (const [i, note] of notes.entries()) expect(note).toMatch(new RegExp(`^DM-${i + 1} done: Wrote work-DM-${i + 1}\\.txt\\. \\(report: .*DM-${i + 1}\\.md\\)$`));

    const events = readFileSync(join(home, "projects", "demo", "events.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const dm4 = events.filter((e) => e.task === "DM-4" && e.type === "task.state").map((e) => `${e.from}>${e.to}`);
    expect(dm4).toEqual(["todo>queued", "queued>starting", "starting>working", "working>done"]);

    // clean: refused until merged; then removes the worktree and terminal, keeps the branch.
    const dm1 = task("DM-1");
    expect((await hcoord("task", "clean", "DM-1")).out).toContain(`${dm1.branch} isn't merged into`);
    git(repo, "merge", "-q", "--ff-only", dm1.branch);
    expect(await ok("task", "clean", "DM-1")).toContain(`branch ${dm1.branch} kept`);
    expect(existsSync(dm1.worktree!)).toBe(false);
    expect(git(repo, "branch", "--list", dm1.branch)).toContain(dm1.branch);
    expect(task("DM-1").worktree).toBeUndefined();
    expect(core.hc("ls", "--all", "--label", "hcoord.task=DM-1").terminals).toEqual([]);

    // clean refuses a dirty worktree, even once merged.
    const dm2 = task("DM-2");
    git(repo, "merge", "-q", "--no-edit", dm2.branch);
    writeFileSync(join(dm2.worktree!, "stray.txt"), "x");
    const dirty = await hcoord("task", "clean", "DM-2");
    expect(dirty.code).toBe(1);
    expect(dirty.out).toContain("has uncommitted changes");
    expect(existsSync(dm2.worktree!)).toBe(true);
  }, 60_000);

  test("a task waiting on a dependency starts when the dependency is done", async () => {
    setup(3);
    await ok("project", "new", "demo", "--repo", repo, "--prefix", "DM");
    await addTask("Schema", { GATE: join(home, "gate-a") });
    await addTask("API", {}, "--depends-on", "DM-1");
    expect(await ok("task", "start", "DM-2", "--parent", coord)).toContain("DM-2 queued: waits for DM-1 (todo)");
    await ok("task", "start", "DM-1", "--parent", coord);
    expect(states()).toEqual({ "DM-1": "working", "DM-2": "queued" });
    writeFileSync(join(home, "gate-a"), "");
    await until("both done", () => tasks().every((t) => t.state === "done"));
    // DM-2 branched from the repo's HEAD, not from DM-1's branch (hcoord never merges).
    expect(git(repo, "log", "--format=%s", task("DM-2").branch)).not.toContain("DM-1");
  }, 60_000);

  test("cancel stops the worker, keeps the worktree, and frees the slot", async () => {
    setup(1);
    await ok("project", "new", "demo", "--repo", repo, "--prefix", "DM");
    await addTask("Slow", { GATE: join(home, "never") });
    await addTask("Next", { GATE: join(home, "never") });
    await ok("task", "start", "DM-1", "--parent", coord);
    expect(await ok("task", "start", "DM-2", "--parent", coord)).toContain("all 1 worker slots are busy");
    const addr = task("DM-1").terminal!.address;

    const out = await ok("task", "cancel", "DM-1");
    expect(out).toContain("DM-1 cancelled; worktree kept at");
    expect(out).toContain(`stopped w-dm-1 (${addr})`);
    expect(out).toContain("started DM-2");
    expect(core.hc("get", addr).state).toBe("finished");
    expect(existsSync(task("DM-1").worktree!)).toBe(true);
    expect(states()).toEqual({ "DM-1": "cancelled", "DM-2": "working" });
    expect((await hcoord("task", "cancel", "DM-1")).out).toContain("DM-1 is already cancelled");
  }, 60_000);

  test("task list marks a worker that exited without reporting as failed, and a blocked one as needs_you", async () => {
    setup(3);
    await ok("project", "new", "demo", "--repo", repo, "--prefix", "DM");
    await addTask("Crashes", { MODE: "exit" });
    await addTask("Blocks", { MODE: "block" });
    await ok("task", "start", "DM-1", "--parent", coord);
    await ok("task", "start", "DM-2", "--parent", coord);
    const [a1, a2] = [task("DM-1").terminal!.address, task("DM-2").terminal!.address];
    await until("DM-1 exited and DM-2 blocked", () => {
      const ls = core.hc("ls", "--all", "--label", "hcoord.project=demo").terminals;
      const by = Object.fromEntries(ls.map((t: any) => [t.address, t]));
      return by[a1]?.state === "finished" && by[a2]?.status === "blocked";
    });

    expect(states()).toEqual({ "DM-1": "working", "DM-2": "working" }); // nothing changes on its own...
    const r = await hcoord("task", "list", "demo");
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("DM-1: working → failed (worker exited without reporting (exit 7)");
    expect(r.stderr).toContain("DM-2: working → needs_you (worker is blocked");
    expect(task("DM-1")).toMatchObject({ state: "failed", summary: expect.stringContaining("exit 7") });
    expect(task("DM-2")).toMatchObject({ state: "needs_you", needsYouAuto: true });
    // A second list changes nothing more.
    expect((await hcoord("task", "list", "demo")).stderr).toBe("");
  }, 60_000);

  test("needs_you: the worker asks, the coordinator is told, and a reply resumes it", async () => {
    setup(3);
    await ok("project", "new", "demo", "--repo", repo, "--prefix", "DM");
    await addTask("Paint", { MODE: "ask" });
    await ok("task", "start", "DM-1", "--parent", coord);
    await until("DM-1 needs you", () => task("DM-1").state === "needs_you");
    expect(task("DM-1").needsYouReason).toBe("Which colour should it be?");
    await until("the question in the inbox", () => existsSync(inbox) && readFileSync(inbox, "utf8").includes("DM-1 needs_you: Which colour should it be?"));
    expect(readFileSync(join(home, "projects", "demo", "TASKS.md"), "utf8")).toContain("## Needs you (1)\n\n- **DM-1** Paint\n  Which colour should it be?");

    expect(await ok("task", "reply", "DM-1", "blue")).toContain("DM-1 → working");
    await until("DM-1 done", () => task("DM-1").state === "done");
    expect(task("DM-1").summary).toBe("Used blue, as asked.");
    const report = readFileSync(join(home, "projects", "demo", "reports", "DM-1.md"), "utf8");
    expect(report).toMatch(/## needs_you · .*\n\nWhich colour[\s\S]*## done · .*\n\nUsed blue/);
    expect((await hcoord("task", "reply", "DM-1", "red")).out).toContain("DM-1 is done, not needs_you");
  }, 60_000);

  test("a launch that fails marks the task failed with the reason", async () => {
    setup(3);
    // A repo with no commits can't have a worktree branch.
    const empty = tempRepo("empty");
    await ok("project", "new", "demo", "--repo", empty, "--prefix", "DM");
    await addTask("Nope", {});
    const r = await hcoord("task", "start", "DM-1", "--parent", coord);
    rmSync(empty, { recursive: true, force: true });
    expect(r.code).toBe(1);
    expect(r.out).toContain("DM-1 failed to start: reading HEAD of");
    expect(task("DM-1")).toMatchObject({ state: "failed", summary: expect.stringContaining("could not start") });
  }, 30_000);
});
