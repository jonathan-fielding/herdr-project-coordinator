/** `hcoord lane new`: a new branch and its worktree where Herdr puts them, registered. */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
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

/** A repo with a commit on main and one more on `feature`, its main checkout on `feature`. */
function repoOnFeature(): string {
  const repo = tempRepo("app");
  dirs.push(repo);
  git(repo, "checkout", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "first");
  git(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "b.txt"), "b\n");
  git(repo, "add", "b.txt");
  git(repo, "commit", "-q", "-m", "second");
  return repo;
}

async function setup(repo: string) {
  const home = tempDir("home");
  const user = tempDir("user"); // stands in for ~, so worktrees land in <user>/.herdr/worktrees
  dirs.push(home, user);
  writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, agent: { kind: "generic", command: ["true"] } }));
  const env = { ...process.env, HOME: user };
  const run = (...args: string[]) => cli(home, args, undefined, env);
  const ok = async (...args: string[]) => {
    const r = await run(...args);
    if (r.code !== 0) throw new Error(`hcoord ${args.join(" ")} → ${r.code}:\n${r.stdout}${r.stderr}`);
    return r.stdout;
  };
  await ok("project", "new", "app", "--repo", repo, "--prefix", "AP");
  const where = (b: string) => join(realpathSync(user), ".herdr", "worktrees", basename(repo), b);
  return { user, run, ok, where };
}

describe("hcoord lane new", () => {
  test("makes a branch from the default branch and a worktree where Herdr would, registered as a worktree", async () => {
    const repo = repoOnFeature();
    const { ok, where } = await setup(repo);
    const made = JSON.parse(await ok("lane", "new", "fix/login", "app", "--json"));
    expect(made).toEqual({ project: "app", lane: "fix-login", path: where("fix-login"), branch: "fix/login", base: "main", created: true });
    expect(git(made.path, "branch", "--show-current")).toBe("fix/login");
    // From main, not the main checkout's feature.
    expect(git(made.path, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "main"));
    expect(existsSync(join(made.path, "b.txt"))).toBe(false);

    const p = JSON.parse(await ok("board", "--json")).projects[0];
    expect(p.lanes.map((l: any) => l.key)).toEqual(["root", "fix-login"]);
  });

  test("--base picks where it starts; plain output says what it made", async () => {
    const repo = repoOnFeature();
    const { ok, where } = await setup(repo);
    const out = await ok("lane", "new", "more", "--base", "feature");
    expect(out).toContain(`made branch more (from feature) at ${where("more")}`);
    expect(git(where("more"), "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "feature"));
  });

  test("a default branch only on origin: starts from origin's, tracking nothing", async () => {
    const upstream = repoOnFeature();
    git(upstream, "checkout", "-q", "main");
    const clone = tempDir("clone");
    dirs.push(clone);
    rmSync(clone, { recursive: true });
    Bun.spawnSync(["git", "clone", "-q", upstream, clone]);
    git(clone, "checkout", "-q", "-b", "work");
    git(clone, "branch", "-q", "-D", "main");
    const { ok } = await setup(clone);
    const made = JSON.parse(await ok("lane", "new", "topic", "--json"));
    expect(made.base).toBe("origin/main");
    expect(git(made.path, "rev-parse", "HEAD")).toBe(git(clone, "rev-parse", "origin/main"));
    expect(Bun.spawnSync(["git", "-C", made.path, "rev-parse", "--abbrev-ref", "topic@{upstream}"], { stderr: "pipe" }).exitCode).not.toBe(0);
  });

  test("refuses a bad name, a branch that exists, a path that exists, and an unknown base; makes nothing", async () => {
    const repo = repoOnFeature();
    const { run, where, user } = await setup(repo);
    const refused = async (args: string[], text: string) => {
      const r = await run("lane", "new", ...args);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain(text);
    };
    await refused(["bad..name"], `"bad..name" isn't a valid branch name`);
    await refused(["feature"], "branch feature already exists; to open it: hcoord lane checkout feature");
    mkdirSync(join(user, ".herdr", "worktrees", basename(repo), "taken"), { recursive: true });
    await refused(["taken"], `${where("taken")} already exists`);
    await refused(["x", "--base", "nope"], "no commit nope");
    await refused([], "hcoord lane new <branch>");
    expect(existsSync(where("bad..name"))).toBe(false);
    expect(existsSync(where("x"))).toBe(false);
    expect(Bun.spawnSync(["git", "-C", repo, "show-ref", "--verify", "--quiet", "refs/heads/x"]).exitCode).not.toBe(0);
  });

  test("lane open takes --space or --new-space, not both", async () => {
    const repo = repoOnFeature();
    const { run } = await setup(repo);
    const r = await run("lane", "open", repo, "--space", "s1", "--new-space", "x");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not both");
  });
});
