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

/**
 * A bare origin with main, the project's clone of it (main checkout on `work` unless `onMain`), and
 * `push(msg)`, which adds a commit to origin's main from another clone. Returns origin's new main.
 */
function withOrigin(onMain = false) {
  const seed = repoOnFeature();
  git(seed, "checkout", "-q", "main"); // so origin's HEAD is main
  const origin = tempDir("origin");
  const clone = tempDir("clone");
  const other = tempDir("other");
  dirs.push(origin, clone, other);
  for (const d of [origin, clone, other]) rmSync(d, { recursive: true });
  Bun.spawnSync(["git", "clone", "-q", "--bare", seed, origin]);
  Bun.spawnSync(["git", "clone", "-q", origin, clone]);
  Bun.spawnSync(["git", "clone", "-q", origin, other]);
  git(clone, "checkout", "-q", "main");
  if (!onMain) git(clone, "checkout", "-q", "-b", "work");
  git(other, "checkout", "-q", "main");
  let n = 0;
  const push = (msg = `upstream ${++n}`, ref = "main") => {
    writeFileSync(join(other, `${msg.replace(/\W+/g, "-")}.txt`), msg);
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", msg);
    git(other, "push", "-q", "origin", `HEAD:${ref}`);
    return git(other, "rev-parse", "HEAD");
  };
  return { clone, origin, other, push };
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

  test("fetches the base first: a local main behind origin's (checked out nowhere) is fast-forwarded", async () => {
    const { clone, push } = withOrigin();
    const before = git(clone, "rev-parse", "main");
    const fresh = push();
    expect(git(clone, "rev-parse", "origin/main")).toBe(before); // stale until fetched
    const { run } = await setup(clone);
    const r = await run("lane", "new", "topic", "--json");
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const made = JSON.parse(r.stdout);
    expect(made.base).toBe("main");
    expect(git(made.path, "rev-parse", "HEAD")).toBe(fresh);
    expect(git(clone, "rev-parse", "main")).toBe(fresh);
    expect(git(clone, "rev-parse", "origin/main")).toBe(fresh);
  });

  test("a main behind origin's that is checked out: starts from origin/main, leaves local main alone", async () => {
    const { clone, push } = withOrigin(true);
    const before = git(clone, "rev-parse", "main");
    const fresh = push();
    const { ok, where } = await setup(clone);
    const out = await ok("lane", "new", "topic");
    expect(out).toContain(`made branch topic (from origin/main) at ${where("topic")}`);
    expect(git(where("topic"), "rev-parse", "HEAD")).toBe(fresh);
    expect(git(clone, "rev-parse", "main")).toBe(before);
  });

  test("an explicit --base branch is fetched too", async () => {
    const { clone, push } = withOrigin(true);
    const fresh = push();
    const { ok } = await setup(clone);
    const made = JSON.parse(await ok("lane", "new", "topic", "--base", "origin/main", "--json"));
    expect(made.base).toBe("origin/main");
    expect(git(made.path, "rev-parse", "HEAD")).toBe(fresh);
  });

  test("a --base pushed to origin since the last fetch is found", async () => {
    const { clone, push } = withOrigin();
    const fresh = push("on release", "release");
    const { ok } = await setup(clone);
    const made = JSON.parse(await ok("lane", "new", "topic", "--base", "release", "--json"));
    expect(made.base).toBe("origin/release");
    expect(git(made.path, "rev-parse", "HEAD")).toBe(fresh);
  });

  test("a local main that has diverged from origin's is used as it is, and not touched", async () => {
    const { clone, push } = withOrigin();
    git(clone, "checkout", "-q", "main");
    writeFileSync(join(clone, "mine.txt"), "mine\n");
    git(clone, "add", "mine.txt");
    git(clone, "commit", "-q", "-m", "local only");
    git(clone, "checkout", "-q", "work");
    const mine = git(clone, "rev-parse", "main");
    const theirs = push();
    const { ok } = await setup(clone);
    const made = JSON.parse(await ok("lane", "new", "topic", "--json"));
    expect(made.base).toBe("main");
    expect(git(made.path, "rev-parse", "HEAD")).toBe(mine);
    expect(git(clone, "rev-parse", "main")).toBe(mine);
    expect(git(clone, "rev-parse", "origin/main")).toBe(theirs); // fetched all the same
  });

  test("a local main ahead of origin's is used as it is", async () => {
    const { clone } = withOrigin();
    git(clone, "checkout", "-q", "main");
    writeFileSync(join(clone, "mine.txt"), "mine\n");
    git(clone, "add", "mine.txt");
    git(clone, "commit", "-q", "-m", "local only");
    git(clone, "checkout", "-q", "work");
    const mine = git(clone, "rev-parse", "main");
    const { ok } = await setup(clone);
    const made = JSON.parse(await ok("lane", "new", "topic", "--json"));
    expect(made.base).toBe("main");
    expect(git(made.path, "rev-parse", "HEAD")).toBe(mine);
  });

  test("a failed fetch warns once and carries on with what's local", async () => {
    const { clone } = withOrigin();
    const local = git(clone, "rev-parse", "main");
    git(clone, "remote", "set-url", "origin", join(clone, "no-such-origin"));
    const { run } = await setup(clone);
    const r = await run("lane", "new", "topic", "--json");
    expect(r.code).toBe(0);
    const lines = r.stderr.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("warning: couldn't fetch main from origin (");
    expect(lines[0]).toEndWith("; using the local copy");
    const made = JSON.parse(r.stdout);
    expect(made.base).toBe("main");
    expect(git(made.path, "rev-parse", "HEAD")).toBe(local);
  });

  test("a fetch that hangs is cut off by the timeout", async () => {
    const { clone } = withOrigin();
    const local = git(clone, "rev-parse", "main");
    // An "ssh" that never answers stands in for a server that hangs.
    git(clone, "config", "core.sshCommand", "sleep 30 #");
    git(clone, "remote", "set-url", "origin", "ssh://nowhere.invalid/repo.git");
    const home = tempDir("home");
    const user = tempDir("user");
    dirs.push(home, user);
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, agent: { kind: "generic", command: ["true"] } }));
    const env = { ...process.env, HOME: user, HCOORD_FETCH_TIMEOUT_MS: "500" };
    expect((await cli(home, ["project", "new", "app", "--repo", clone, "--prefix", "AP"], undefined, env)).code).toBe(0);
    const t0 = Date.now();
    const r = await cli(home, ["lane", "new", "topic", "--json"], undefined, env);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("couldn't fetch main from origin (timed out after");
    expect(git(JSON.parse(r.stdout).path, "rev-parse", "HEAD")).toBe(local);
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
