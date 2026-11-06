/** hcoord lane remove and project delete. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestCore } from "./hccore.ts";
import { CLI, cli, tempDir, tempRepo } from "./helpers.ts";

let home: string;
let repo: string;
let other: string;
afterEach(() => {
  for (const d of [home, repo, other]) if (d) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};
const env = () => ({ ...process.env, HCOORD_NO_TRASH: "1" });
const ok = async (...args: string[]) => {
  const r = await cli(home, args, undefined, env());
  if (r.code !== 0) throw new Error(`hcoord ${args.join(" ")} → ${r.code}:\n${r.stdout}${r.stderr}`);
  return r.stdout;
};

function setup() {
  home = tempDir("home");
  repo = tempRepo("app");
  other = tempDir("wt");
  writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, agent: { kind: "generic", command: ["true"] } }));
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "first");
  git(repo, "worktree", "add", "-q", "-b", "feature/x", join(other, "x"));
}

describe("lane remove", () => {
  test("asks first (dry run), refuses uncommitted changes without --force, keeps the branch", async () => {
    setup();
    const wt = join(other, "x");
    await ok("project", "new", "demo", "--repo", repo, "--prefix", "DM");
    // Registers the worktree as a lane, as opening its coordinator would.
    await ok("task", "add", "--title", "T", "--brief", "b");
    const meta = JSON.parse(await ok("project", "show", "demo", "--json"));
    expect(Object.keys(meta.lanes ?? meta.meta?.lanes ?? {})).toContain("root");

    writeFileSync(join(wt, "new.txt"), "x");
    const plan = JSON.parse(await ok("lane", "remove", wt, "--dry-run", "--json"));
    expect(plan).toMatchObject({ project: "demo", path: wt, branch: "feature/x", changed: ["new.txt"], unfinished: [] });

    const refused = await cli(home, ["lane", "remove", wt], undefined, env());
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("uncommitted changes");
    expect(existsSync(wt)).toBe(true);

    expect(await ok("lane", "remove", wt, "--force")).toContain("branch feature/x kept");
    expect(existsSync(wt)).toBe(false);
    expect(git(repo, "branch", "--list", "feature/x")).toContain("feature/x");
  });

  test("the main checkout isn't a worktree to remove", async () => {
    setup();
    await ok("project", "new", "demo", "--repo", repo);
    const r = await cli(home, ["lane", "remove", repo, "--dry-run", "--json"], undefined, env());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("main checkout");
  });

  test("a registered worktree's unfinished tasks are cancelled and it is forgotten", async () => {
    setup();
    const wt = join(other, "x");
    await ok("project", "new", "demo", "--repo", repo, "--prefix", "DM");
    const pj = join(home, "projects", "demo", "project.json");
    const m = JSON.parse(await Bun.file(pj).text());
    m.lanes["feature-x"] = { path: wt, branch: "feature/x", createdAt: "2026-11-02T00:00:00Z" };
    writeFileSync(pj, JSON.stringify(m));
    await ok("task", "add", "--title", "T", "--brief", "b", "--lane", "feature-x");
    expect(JSON.parse(await ok("lane", "remove", wt, "--dry-run", "--json")).unfinished).toEqual(["DM-1"]);
    const outp = await ok("lane", "remove", wt);
    expect(outp).toContain("cancelled DM-1");
    expect(JSON.parse(await Bun.file(pj).text()).lanes["feature-x"]).toBeUndefined();
    const t = JSON.parse(await ok("task", "show", "DM-1", "--json"));
    expect(t.state ?? t.task?.state).toBe("cancelled");
  });
});

describe("project delete", () => {
  test("just from hcoord: the repo and worktrees stay, its data moves to deleted/", async () => {
    setup();
    await ok("project", "new", "demo", "--repo", repo, "--prefix", "DM");
    await ok("task", "add", "--title", "T", "--brief", "b");
    const plan = JSON.parse(await ok("project", "delete", "demo", "--dry-run", "--json"));
    expect(plan.checkouts.map((c: any) => c.path)).toEqual([repo, join(other, "x")]);
    expect(plan.unpushed).toBe(1);
    expect(plan.trash).toBe(false);

    const outp = await ok("project", "delete", "demo");
    expect(outp).toContain("cancelled DM-1");
    expect(existsSync(join(home, "projects", "demo"))).toBe(false);
    expect(readdirSync(join(home, "deleted"))[0]).toStartWith("demo-");
    expect(existsSync(join(repo, "a.txt"))).toBe(true);
    expect(existsSync(join(other, "x"))).toBe(true);
    expect(JSON.parse(await ok("board", "--json")).projects).toEqual([]);
  });

  test("with --files: the repo and its worktrees go too", async () => {
    setup();
    await ok("project", "new", "demo", "--repo", repo, "--prefix", "DM");
    const outp = await ok("project", "delete", "demo", "--files");
    expect(outp).toContain(`deleted ${repo}`);
    expect(existsSync(repo)).toBe(false);
    expect(existsSync(join(other, "x"))).toBe(false);
  });

  test("needs the project named", async () => {
    setup();
    await ok("project", "new", "demo", "--repo", repo);
    expect((await cli(home, ["project", "delete"], undefined, env())).code).toBe(2);
  });
});

describe("lane remove with a cleanup prompt", () => {
  const core = new TestCore();
  beforeAll(() => core.start());
  afterAll(() => core.stop());
  afterEach(() => {
    for (const t of core.hc("ls", "--label", "hcoord.project=demo").terminals ?? []) core.hc("kill", t.address);
  });

  const hcoord = (args: string[], stdin?: string) => cli(home, args, stdin, core.env);
  const must = async (...args: string[]) => {
    const r = await hcoord(args);
    if (r.code !== 0) throw new Error(`hcoord ${args.join(" ")} → ${r.code}:\n${r.stdout}${r.stderr}`);
    return r.stdout;
  };
  const wt = () => join(other, "x");
  const lane = () => JSON.parse(readFileSync(join(home, "projects", "demo", "project.json"), "utf8")).lanes["feature-x"];
  const task = async (id: string) => JSON.parse(await must("task", "show", id, "--json"));
  const inbox = () => (existsSync(join(home, "inbox.txt")) ? readFileSync(join(home, "inbox.txt"), "utf8") : "");
  const live = (address: string) => core.hc("get", address).state === "live";
  const reportAs = (id: string, state: string, text: string) => hcoord(["report", id, "--state", state, "--file", "-"], text);
  async function until(what: string, pred: () => boolean, ms = 15_000) {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}; inbox: ${inbox()}`);
      await Bun.sleep(100);
    }
  }

  /**
   * A project with a cleanup prompt and the worktree feature/x. Coordinator and workers are stand-ins:
   * what's typed into one lands in <home>/inbox.txt, or, after "run:", is run in its terminal.
   */
  async function cleanupProject(prompt: string | null = "Drop the test database.") {
    setup();
    const standIn = `while IFS= read -r l; do case "$l" in run:*) eval "\${l#run:}";; *) echo "$l" >> '${join(home, "inbox.txt")}';; esac; done`;
    writeFileSync(join(home, "config.json"), JSON.stringify({
      version: 1,
      agent: { kind: "generic", command: ["sh", "-c", standIn], coordinatorArgs: [] },
      worktreeRoot: join(home, "wt"),
    }));
    await must("project", "new", "demo", "--repo", repo, "--prefix", "DM");
    if (prompt) expect((await hcoord(["settings", "set", "--cleanup-prompt-file", "-"], prompt)).code).toBe(0);
  }

  /** Deletes the worktree and starts its cleanup task, as its coordinator would. Returns the task's id. */
  async function deferred(...flags: string[]): Promise<string> {
    const r = JSON.parse(await must("lane", "remove", wt(), "--json", ...flags));
    expect(r.cleanup).toMatch(/^DM-\d+$/);
    await must("task", "start", r.cleanup);
    return r.cleanup;
  }

  const commitIn = async (id: string) => {
    const dir = (await task(id)).worktree;
    writeFileSync(join(dir, "cleaned.txt"), "x");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "cleaned");
  };

  test("defers: cancels the open tasks, adds a cleanup task saying where, tells the coordinator", async () => {
    await cleanupProject();
    await must("lane", "open", wt(), "--no-show");
    await must("task", "add", "--title", "T", "--brief", "b", "--lane", "feature-x");

    const plan = JSON.parse(await must("lane", "remove", wt(), "--dry-run", "--json"));
    expect(plan).toMatchObject({ cleanupPrompt: "Drop the test database.", removing: null });

    const out = await must("lane", "remove", wt());
    expect(out).toContain("cancelled DM-1");
    expect(out).toContain("once DM-2 is merged");
    expect(existsSync(wt())).toBe(true);

    const t = await task("DM-2");
    expect(t).toMatchObject({ state: "todo", lane: "feature-x", cleanup: true });
    expect(t.brief).toContain("Drop the test database.");
    expect(t.brief).toContain(wt());
    expect(t.brief).toContain("feature/x");
    expect(lane().removing).toEqual({ task: "DM-2", force: false, since: expect.any(String) });
    await until("the coordinator to be told", () => inbox().includes("hcoord task start DM-2"));

    expect(JSON.parse(await must("lane", "remove", wt(), "--dry-run", "--json")).removing).toMatchObject({ task: "DM-2" });
    const p = JSON.parse(await must("board", "--json")).projects[0];
    expect(p.lanes.find((l: any) => l.key === "feature-x").removing).toMatchObject({ task: "DM-2", state: "todo", force: false });
    expect(p.lanes.find((l: any) => l.key === "root").removing).toBeNull();
    expect(p.tasks.find((x: any) => x.id === "DM-2").cleanup).toBe(true);
  });

  test("an unregistered worktree: its coordinator is started, without a space, to run the task", async () => {
    await cleanupProject();
    const r = JSON.parse(await must("lane", "remove", wt(), "--json"));
    expect(r).toMatchObject({ ok: true, cleanup: "DM-1" });
    expect(r.lines.join("\n")).toContain("started coordinator");
    expect(lane().coordinator).toBeDefined();
    await until("the coordinator to be told", () => inbox().includes("hcoord task start DM-1"));
  });

  test("the same refusals come first", async () => {
    await cleanupProject();
    expect((await hcoord(["lane", "remove", repo])).stderr).toContain("main checkout");
    writeFileSync(join(wt(), "new.txt"), "x");
    const r = await hcoord(["lane", "remove", wt()]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("uncommitted changes");
    expect(JSON.parse(await must("task", "list", "--json", "--all-lanes"))).toEqual([]);
  });

  test("merged finishes it: the worker's note first, then all of it goes, the branch stays", async () => {
    await cleanupProject();
    const id = await deferred();
    const c = lane().coordinator.address;
    await must("task", "add", "--title", "Late", "--brief", "b", "--lane", "feature-x");
    await commitIn(id);

    const r = await reportAs(id, "done", "Dropped it.");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`merged`);
    expect(r.stdout).toContain("branch feature/x kept");
    await until("the worker's note", () => inbox().includes(`${id} done (merged into feature/x): Dropped it.`));
    expect(existsSync(wt())).toBe(false);
    expect(lane()).toBeUndefined();
    expect(live(c)).toBe(false);
    expect(git(repo, "branch", "--list", "feature/x")).toContain("feature/x");
    expect(git(repo, "log", "-1", "--format=%s", "feature/x")).toContain("Merge");
    expect((await task("DM-2")).state).toBe("cancelled");
    // The worker outlives the coordinator it reported to.
    expect(live((await task(id)).terminal.address)).toBe(true);
  });

  test("nothing to merge finishes it too", async () => {
    await cleanupProject();
    const id = await deferred();
    const r = await reportAs(id, "done", "Nothing needed committing.");
    expect(r.code).toBe(0);
    await until("the worker's note", () => inbox().includes(`${id} done (nothing to merge`));
    expect(existsSync(wt())).toBe(false);
    expect(lane()).toBeUndefined();
    expect((await task(id)).state).toBe("merged");
  });

  test("done but not merged keeps it, and a later task merge finishes it", async () => {
    await cleanupProject();
    const id = await deferred();
    await commitIn(id);
    // An uncommitted file in the worktree that the merge would overwrite.
    writeFileSync(join(wt(), "cleaned.txt"), "mine");

    const r = await reportAs(id, "done", "Dropped it.");
    expect(r.code).toBe(0);
    await until("the worker's note", () => inbox().includes(`${id} done (NOT merged`));
    expect(existsSync(wt())).toBe(true);
    expect(lane().removing.task).toBe(id);

    rmSync(join(wt(), "cleaned.txt"));
    expect(await must("task", "merge", id)).toContain("branch feature/x kept");
    expect(existsSync(wt())).toBe(false);
    expect(lane()).toBeUndefined();
  });

  test("task merge run by the coordinator itself: stopping it doesn't cut the removal short", async () => {
    await cleanupProject();
    const id = await deferred();
    await commitIn(id);
    writeFileSync(join(wt(), "cleaned.txt"), "mine");
    await reportAs(id, "done", "Dropped it.");
    rmSync(join(wt(), "cleaned.txt"));

    const c = lane().coordinator.address;
    core.hc("send", c, `run:'${process.execPath}' '${CLI}' task merge ${id}`);
    await until("the removal", () => !existsSync(wt()) && lane() === undefined);
    await until("the coordinator to stop", () => !live(c));
  });

  test("failed keeps it, and a retry that merges finishes it", async () => {
    await cleanupProject();
    const id = await deferred();
    expect((await reportAs(id, "failed", "The database is busy.")).code).toBe(0);
    await until("the failure note", () => inbox().includes(`${id} failed: The database is busy.`));
    expect(existsSync(wt())).toBe(true);
    expect(lane().removing.task).toBe(id);

    await must("task", "retry", id);
    await reportAs(id, "done", "Dropped it after all.");
    expect(existsSync(wt())).toBe(false);
    expect(lane()).toBeUndefined();
  });

  test("git refusing keeps it, says so, and a later task merge or delete finishes it", async () => {
    await cleanupProject();
    const id = await deferred();
    writeFileSync(join(wt(), "left-behind.txt"), "x");

    const r = await reportAs(id, "done", "Dropped it.");
    expect(r.code).toBe(0);
    await until("the coordinator to hear", () => inbox().includes(`${id} merged, but the worktree wasn't removed`));
    expect(existsSync(wt())).toBe(true);
    expect(live(lane().coordinator.address)).toBe(true);
    expect((await task(id)).state).toBe("merged");

    const again = await hcoord(["task", "merge", id]);
    expect(again.code).toBe(1);
    expect(again.stdout).toContain("wasn't removed");

    // Deleting again, now forced, doesn't add a task.
    expect(await must("lane", "remove", wt(), "--force")).toContain("branch feature/x kept");
    expect(existsSync(wt())).toBe(false);
    expect(lane()).toBeUndefined();
    expect(JSON.parse(await must("task", "list", "--json", "--all-lanes"))).toHaveLength(1);
  });

  test("a saved --force removes it despite changes", async () => {
    await cleanupProject();
    writeFileSync(join(wt(), "new.txt"), "x");
    const id = await deferred("--force");
    expect(lane().removing.force).toBe(true);
    await reportAs(id, "done", "Dropped it.");
    expect(existsSync(wt())).toBe(false);
  });

  test("cancelling the cleanup task clears the removal; the worktree stays, a new delete starts over", async () => {
    await cleanupProject();
    const id = await deferred();
    const worker = (await task(id)).terminal.address;
    expect(await must("task", "cancel", id)).toContain("called off");
    expect(lane().removing).toBeUndefined();
    expect(existsSync(wt())).toBe(true);
    expect(live(worker)).toBe(false);

    const refused = await hcoord(["task", "retry", id]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("called off");

    expect(JSON.parse(await must("lane", "remove", wt(), "--json")).cleanup).not.toBe(id);
  });

  test("a failed cleanup task can be cancelled too", async () => {
    await cleanupProject();
    const id = await deferred();
    await reportAs(id, "failed", "No.");
    await must("task", "cancel", id);
    expect(lane().removing).toBeUndefined();
    expect((await task(id)).state).toBe("cancelled");
  });

  test("--skip-cleanup removes it now and calls off the pending removal", async () => {
    await cleanupProject();
    const id = await deferred();
    const worker = (await task(id)).terminal.address;
    const out = await must("lane", "remove", wt(), "--skip-cleanup");
    expect(out).toContain(`cancelled ${id}`);
    expect(out).toContain("branch feature/x kept");
    expect(existsSync(wt())).toBe(false);
    expect(lane()).toBeUndefined();
    expect((await task(id)).state).toBe("cancelled");
    expect(live(worker)).toBe(false);
  });

  test("--skip-cleanup after the cleanup failed, or with nothing pending", async () => {
    await cleanupProject();
    const id = await deferred();
    await reportAs(id, "failed", "No.");
    expect(JSON.parse(await must("lane", "remove", wt(), "--skip-cleanup", "--json"))).toMatchObject({ ok: true, cleanup: null });
    expect((await task(id)).state).toBe("cancelled");
    expect(existsSync(wt())).toBe(false);

    git(repo, "worktree", "add", "-q", wt(), "feature/x");
    await must("lane", "remove", wt(), "--skip-cleanup");
    expect(existsSync(wt())).toBe(false);
    expect(JSON.parse(await must("task", "list", "--json", "--all-lanes"))).toHaveLength(1);
  });

  test("deleting again reuses the task, keeps it running, and takes up a --force", async () => {
    await cleanupProject();
    const first = JSON.parse(await must("lane", "remove", wt(), "--json")).cleanup;
    await until("the coordinator to be told", () => inbox().includes(`hcoord task start ${first}`));

    // Not started yet: it's told again, in case the first message went astray.
    expect(JSON.parse(await must("lane", "remove", wt(), "--json")).cleanup).toBe(first);
    await until("the second message", () => inbox().split(`hcoord task start ${first}`).length === 3);

    await must("task", "start", first);
    const worker = (await task(first)).terminal.address;
    const running = JSON.parse(await must("lane", "remove", wt(), "--json", "--force"));
    expect(running.cleanup).toBe(first);
    expect(running.lines.join("\n")).toContain("working");
    expect(lane().removing.force).toBe(true);
    expect((await task(first)).state).toBe("working");
    expect(live(worker)).toBe(true);
    expect(JSON.parse(await must("task", "list", "--json", "--all-lanes"))).toHaveLength(1);

    await reportAs(first, "failed", "No.");
    expect(JSON.parse(await must("lane", "remove", wt(), "--json")).cleanup).toBe(first);
    await until("the retry message", () => inbox().includes(`hcoord task retry ${first}`));
  });

  test("two deletes at once add one task", async () => {
    await cleanupProject();
    const both = await Promise.all([hcoord(["lane", "remove", wt(), "--json"]), hcoord(["lane", "remove", wt(), "--json"])]);
    const ids = both.map((r) => JSON.parse(r.stdout).cleanup);
    expect(ids[0]).toBe(ids[1]);
    expect(JSON.parse(await must("task", "list", "--json", "--all-lanes"))).toHaveLength(1);
  });

  test("no prompt: straight away, as before", async () => {
    await cleanupProject(null);
    await must("lane", "open", wt(), "--no-show");
    const c = lane().coordinator.address;
    await must("task", "add", "--title", "T", "--brief", "b", "--lane", "feature-x");
    expect(JSON.parse(await must("lane", "remove", wt(), "--dry-run", "--json"))).toMatchObject({ cleanupPrompt: null, removing: null });
    const out = await must("lane", "remove", wt());
    expect(out).toContain("cancelled DM-1");
    expect(out).toContain("branch feature/x kept");
    expect(existsSync(wt())).toBe(false);
    expect(lane()).toBeUndefined();
    expect(live(c)).toBe(false);
    expect(inbox()).toBe("");
    expect(JSON.parse(await must("task", "list", "--json", "--all-lanes"))).toHaveLength(1);
  });
});
