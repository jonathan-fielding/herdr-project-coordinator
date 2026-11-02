/** hcoord lane remove and project delete. */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, tempDir, tempRepo } from "./helpers.ts";

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
