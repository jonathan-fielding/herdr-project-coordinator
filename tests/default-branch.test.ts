/** A project whose main checkout isn't on the default branch still offers it, and `lane checkout` makes it. */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { defaultBranch } from "../src/git.ts";
import { cli, tempDir, tempRepo } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
}

/** A repo with one commit on main, its main checkout switched to `feature`. */
function repoOnFeature(): string {
  const repo = tempRepo("app");
  dirs.push(repo);
  git(repo, "checkout", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "first");
  git(repo, "checkout", "-q", "-b", "feature");
  return repo;
}

function setup() {
  const home = tempDir("home");
  const user = tempDir("user"); // stands in for ~, so worktrees land in <user>/.herdr/worktrees
  dirs.push(home, user);
  writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, agent: { kind: "generic", command: ["true"] } }));
  const env = { ...process.env, HOME: user };
  const ok = async (...args: string[]) => {
    const r = await cli(home, args, undefined, env);
    if (r.code !== 0) throw new Error(`hcoord ${args.join(" ")} → ${r.code}:\n${r.stdout}${r.stderr}`);
    return r.stdout;
  };
  return { home, user, env, ok };
}

describe("default branch", () => {
  test("found from origin/HEAD, else main or master", () => {
    const repo = repoOnFeature();
    expect(defaultBranch(repo)).toBe("main");

    const clone = tempDir("clone");
    dirs.push(clone);
    rmSync(clone, { recursive: true });
    git(repo, "branch", "-q", "trunk", "main");
    git(repo, "symbolic-ref", "HEAD", "refs/heads/trunk");
    Bun.spawnSync(["git", "clone", "-q", repo, clone]);
    expect(defaultBranch(clone)).toBe("trunk");
  });

  test("the board offers a default branch nothing has checked out; lane checkout makes it where Herdr would", async () => {
    const repo = repoOnFeature();
    const { user, ok } = setup();
    await ok("project", "new", "app", "--repo", repo, "--prefix", "AP");

    const where = join(realpathSync(user), ".herdr", "worktrees", basename(repo), "main");
    let p = JSON.parse(await ok("board", "--json")).projects[0];
    expect(p.defaultBranch).toEqual({ name: "main", path: where, checkedOut: false });

    const made = JSON.parse(await ok("lane", "checkout", "main", "app", "--json"));
    expect(made).toMatchObject({ project: "app", lane: "main", path: where, branch: "main", created: true });
    expect(git(where, "branch", "--show-current")).toBe("main");

    p = JSON.parse(await ok("board", "--json")).projects[0];
    expect(p.defaultBranch).toEqual({ name: "main", path: where, checkedOut: true });
    expect(p.lanes.map((l: any) => l.key)).toEqual(["root", "main"]);

    // Again: the checkout git has is reused, nothing new is made.
    const again = JSON.parse(await ok("lane", "checkout", "main", "--json"));
    expect(again).toMatchObject({ path: where, created: false, lane: "main" });
  });

  test("a branch only on origin gets a local branch tracking it", async () => {
    const upstream = repoOnFeature();
    git(upstream, "checkout", "-q", "main");
    const clone = tempDir("clone");
    dirs.push(clone);
    rmSync(clone, { recursive: true });
    Bun.spawnSync(["git", "clone", "-q", upstream, clone]);
    git(clone, "checkout", "-q", "-b", "work");
    git(clone, "branch", "-q", "-D", "main");

    const { ok } = setup();
    await ok("project", "new", "app", "--repo", clone, "--prefix", "AP");
    const made = JSON.parse(await ok("lane", "checkout", "main", "--json"));
    expect(made.created).toBe(true);
    expect(git(made.path, "rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("origin/main");
  });

  test("an unknown branch is refused and nothing is made", async () => {
    const repo = repoOnFeature();
    const { user, home, env } = setup();
    await cli(home, ["project", "new", "app", "--repo", repo, "--prefix", "AP"], undefined, env);
    const r = await cli(home, ["lane", "checkout", "nope", "--json"], undefined, env);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("no branch nope");
    expect(existsSync(join(user, ".herdr", "worktrees", basename(repo), "nope"))).toBe(false);
  });
});
