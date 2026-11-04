/** `hcoord project new --git-init`: a plain folder made into a project workers can use. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureWorktree } from "../src/git.ts";
import { cli, tempDir, tempRepo } from "./helpers.ts";

let home: string;
let folder: string;
let gitconfig: string;
let dirs: string[];

const gitEnv = () => {
  const { GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL, EMAIL, ...env } = process.env;
  return { ...env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1" };
};

function setConfig(...lines: string[]) {
  writeFileSync(gitconfig, lines.join("\n") + "\n");
}
const IDENTITY = ["[user]", "  name = Tess", "  email = tess@example.com"];

beforeEach(() => {
  home = tempDir("home");
  folder = tempDir("plain");
  gitconfig = join(home, "gitconfig");
  dirs = [home, folder];
  setConfig(...IDENTITY);
});
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const run = (...args: string[]) => cli(home, args, undefined, gitEnv());
const ok = async (...args: string[]) => {
  const r = await run(...args);
  if (r.code !== 0) throw new Error(`hcoord ${args.join(" ")} → ${r.code}: ${r.stderr}`);
  return r.stdout;
};
function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
}
const dotGit = () => existsSync(join(folder, ".git"));
const projects = () => (existsSync(join(home, "projects")) ? readdirSync(join(home, "projects")) : []);
function write(rel: string, text = "x\n") {
  mkdirSync(join(folder, rel, ".."), { recursive: true });
  writeFileSync(join(folder, rel), text);
}

describe("project new --git-init", () => {
  test("inits, commits the files and makes the project; a worktree can be made from it", async () => {
    write("README.md");
    write("src/app.ts");
    const meta = JSON.parse(await ok("project", "new", "plain", "--repo", folder, "--git-init", "--json"));
    expect(meta).toMatchObject({ slug: "plain", repo: folder, lanes: { root: { path: folder, branch: git(folder, "symbolic-ref", "--short", "HEAD") } } });
    expect(git(folder, "log", "--format=%s|%an|%ae")).toBe("Initial commit|Tess|tess@example.com");
    expect(git(folder, "ls-files").split("\n")).toEqual(["README.md", "src/app.ts"]);
    expect(git(folder, "status", "--porcelain")).toBe("");

    const wt = join(home, "wt");
    const made = ensureWorktree(meta.repo, wt, "coord/root/pl-1-x");
    expect(made.reused).toBe(false);
    expect(readFileSync(join(wt, "src", "app.ts"), "utf8")).toBe("x\n");
  });

  test("respects init.defaultBranch", async () => {
    setConfig(...IDENTITY, "[init]", "  defaultBranch = trunk");
    const meta = JSON.parse(await ok("project", "new", "plain", "--repo", folder, "--git-init", "--json"));
    expect(meta.lanes.root.branch).toBe("trunk");
    expect(git(folder, "symbolic-ref", "--short", "HEAD")).toBe("trunk");
  });

  test("leaves gitignored files out", async () => {
    write(".gitignore", "node_modules/\n*.log\n");
    write("keep.txt");
    write("debug.log");
    write("node_modules/dep/index.js");
    await ok("project", "new", "plain", "--repo", folder, "--git-init");
    expect(git(folder, "ls-files").split("\n")).toEqual([".gitignore", "keep.txt"]);
    expect(existsSync(join(folder, "debug.log"))).toBe(true);
  });

  test("an empty folder gets an empty commit, so worktrees still work", async () => {
    const meta = JSON.parse(await ok("project", "new", "plain", "--repo", folder, "--git-init", "--json"));
    expect(git(folder, "log", "--format=%s")).toBe("Initial commit");
    expect(git(folder, "ls-files")).toBe("");
    expect(ensureWorktree(meta.repo, join(home, "wt"), "b").reused).toBe(false);
  });

  test("a folder whose files are all ignored gets an empty commit too", async () => {
    setConfig(...IDENTITY, "[core]", `  excludesFile = ${join(home, "ignore")}`);
    writeFileSync(join(home, "ignore"), "*\n");
    write("secret.txt");
    await ok("project", "new", "plain", "--repo", folder, "--git-init");
    expect(git(folder, "ls-files")).toBe("");
    expect(git(folder, "log", "--format=%s")).toBe("Initial commit");
  });

  test("changes nothing in a folder already in a repo", async () => {
    const repo = tempRepo("app");
    dirs.push(repo);
    writeFileSync(join(repo, "src", "untracked.txt"), "x\n");
    const meta = JSON.parse(await ok("project", "new", "app", "--repo", join(repo, "src"), "--git-init", "--json"));
    expect(meta.repo).toBe(repo);
    expect(existsSync(join(repo, "src", ".git"))).toBe(false);
    expect(Bun.spawnSync(["git", "-C", repo, "rev-parse", "--verify", "-q", "HEAD"]).exitCode).not.toBe(0);
    expect(git(repo, "status", "--porcelain")).toBe("?? src/");
  });

  test("without it a plain folder is still refused, in the words the mod matches on", async () => {
    write("README.md");
    const r = await run("project", "new", "plain", "--repo", folder);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not a git repository");
    expect(dotGit()).toBe(false);
  });
});

describe("refused runs leave no .git", () => {
  beforeEach(() => write("README.md"));

  test("bad name and bad prefix", async () => {
    expect((await run("project", "new", "!!!", "--repo", folder, "--git-init")).code).toBe(2);
    expect((await run("project", "new", "plain", "--repo", folder, "--git-init", "--prefix", "1x")).code).toBe(2);
    expect(dotGit()).toBe(false);
  });

  test("duplicate project and prefix clash", async () => {
    const repo = tempRepo("app");
    dirs.push(repo);
    await ok("project", "new", "website", "--repo", repo);
    const dup = await run("project", "new", "Website", "--repo", folder, "--git-init");
    expect(dup.stderr).toContain('project "website" already exists');
    const clash = await run("project", "new", "webapp", "--repo", folder, "--git-init");
    expect(clash.stderr).toContain('prefix WEB is used by "website"');
    expect(dotGit()).toBe(false);
  });

  test("missing git identity says how to set it", async () => {
    setConfig("[init]", "  defaultBranch = main");
    const r = await run("project", "new", "plain", "--repo", folder, "--git-init");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("user.name / user.email");
    expect(r.stderr).toContain("git config --global user.email");
    expect(dotGit()).toBe(false);
    expect(projects()).toEqual([]);
  });

  test("half an identity is missing too", async () => {
    setConfig("[user]", "  name = Tess");
    expect((await run("project", "new", "plain", "--repo", folder, "--git-init")).stderr).toContain("user.name / user.email");
    expect(dotGit()).toBe(false);
  });

  test("a missing folder, and a file", async () => {
    const gone = join(folder, "gone");
    expect((await run("project", "new", "plain", "--repo", gone, "--git-init")).stderr).toContain("no such folder");
    const file = join(folder, "README.md");
    expect((await run("project", "new", "plain", "--repo", file, "--git-init")).stderr).toContain("not a folder");
    expect(dotGit()).toBe(false);
  });

  test("a .git that isn't a repo is refused and left alone", async () => {
    mkdirSync(join(folder, ".git"));
    writeFileSync(join(folder, ".git", "mine"), "x\n");
    const r = await run("project", "new", "plain", "--repo", folder, "--git-init");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("isn't a working git repository");
    expect(readdirSync(join(folder, ".git"))).toEqual(["mine"]);
  });
});

describe("a failed add or commit", () => {
  beforeEach(() => write("README.md"));

  test("removes the .git it made, and a retry starts clean", async () => {
    const hooks = join(home, "hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho hook said no >&2\nexit 1\n", { mode: 0o755 });
    setConfig(...IDENTITY, "[core]", `  hooksPath = ${hooks}`);
    const r = await run("project", "new", "plain", "--repo", folder, "--git-init");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("hook said no");
    expect(dotGit()).toBe(false);
    expect(projects()).toEqual([]);

    setConfig(...IDENTITY);
    await ok("project", "new", "plain", "--repo", folder, "--git-init");
    expect(git(folder, "log", "--format=%s")).toBe("Initial commit");
  });

  test("a failed add does too", async () => {
    // git add refuses a nested repo with no commit in it.
    const nested = join(folder, "nested");
    mkdirSync(nested);
    git(nested, "init", "-q");
    writeFileSync(join(nested, "file"), "x\n");
    const r = await run("project", "new", "plain", "--repo", folder, "--git-init");
    expect(r.code).toBe(1);
    expect(dotGit()).toBe(false);
    expect(existsSync(join(nested, ".git"))).toBe(true);
    expect(projects()).toEqual([]);
  });
});

describe("--git-init --dry-run", () => {
  const dry = (...more: string[]) => ok("project", "new", "plain", "--repo", folder, "--git-init", "--dry-run", "--json", ...more);
  const snapshot = (dir = folder) => readdirSync(dir, { recursive: true }).map(String).sort();

  test("says what would be committed and changes nothing", async () => {
    write(".gitignore", "*.log\n");
    write("a.txt");
    write("src/b.txt");
    write("debug.log");
    const before = snapshot();
    expect(JSON.parse(await dry())).toEqual({
      repo: folder,
      gitInit: true,
      files: [".gitignore", "a.txt", "src/b.txt"],
      count: 3,
      hasGitignore: true,
    });
    expect(snapshot()).toEqual(before);
    expect(dotGit()).toBe(false);
    expect(projects()).toEqual([]);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  test("gives the same files a real run commits", async () => {
    write(".gitignore", "*.log\n");
    write("space name.txt");
    write(" leading.txt");
    write("ünï.txt");
    write("debug.log");
    const { files } = JSON.parse(await dry());
    await ok("project", "new", "plain", "--repo", folder, "--git-init");
    const committed = Bun.spawnSync(["git", "-C", folder, "ls-files", "-z"]).stdout.toString();
    expect(committed.split("\0").filter(Boolean).sort()).toEqual([...files].sort());
  });

  test("caps files at 200, count stays true", async () => {
    for (let i = 0; i < 205; i++) write(`f${String(i).padStart(3, "0")}.txt`);
    const plan = JSON.parse(await dry());
    expect(plan.files).toHaveLength(200);
    expect(plan.count).toBe(205);
    expect(plan.hasGitignore).toBe(false);
  });

  test("an empty folder", async () => {
    expect(JSON.parse(await dry())).toMatchObject({ gitInit: true, files: [], count: 0, hasGitignore: false });
  });

  test("a folder already in a repo would not init", async () => {
    const repo = tempRepo("app");
    dirs.push(repo);
    writeFileSync(join(repo, ".gitignore"), "x\n");
    const out = await ok("project", "new", "plain", "--repo", join(repo, "src"), "--git-init", "--dry-run", "--json");
    expect(JSON.parse(out)).toEqual({ repo, gitInit: false, files: [], count: 0, hasGitignore: true });
    expect(projects()).toEqual([]);
  });

  test("refuses what a real run would refuse", async () => {
    write("a.txt");
    setConfig("[init]", "  defaultBranch = main");
    expect((await run("project", "new", "plain", "--repo", folder, "--git-init", "--dry-run", "--json")).stderr).toContain("user.name / user.email");
    setConfig(...IDENTITY);
    const repo = tempRepo("app");
    dirs.push(repo);
    await ok("project", "new", "plain", "--repo", repo);
    expect((await run("project", "new", "plain", "--repo", folder, "--git-init", "--dry-run", "--json")).stderr).toContain("already exists");
    expect(dotGit()).toBe(false);
  });

  test("in words, without --json", async () => {
    write("a.txt");
    const text = await ok("project", "new", "plain", "--repo", folder, "--git-init", "--dry-run");
    expect(text).toContain(`would git init ${folder} and commit 1 file(s) (no .gitignore):\n  a.txt`);
  });

  test("needs --git-init", async () => {
    const r = await run("project", "new", "plain", "--repo", folder, "--dry-run");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--dry-run only goes with --git-init");
    expect(projects()).toEqual([]);
  });
});
