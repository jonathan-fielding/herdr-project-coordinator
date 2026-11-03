/** `hcoord lane branches`: what the New worktree dialog's "Start from" list offers. */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listBranches } from "../src/git.ts";
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

/** An upstream with main, Zeta, alpha and feature/x; a clone of it with local branches beta and local-only too. */
function cloned(): { upstream: string; clone: string } {
  const upstream = tempRepo("upstream");
  dirs.push(upstream);
  git(upstream, "checkout", "-q", "-b", "main");
  writeFileSync(join(upstream, "a.txt"), "a\n");
  git(upstream, "add", "a.txt");
  git(upstream, "commit", "-q", "-m", "first");
  for (const b of ["Zeta", "alpha", "feature/x"]) git(upstream, "branch", b);
  const parent = tempDir("clone");
  dirs.push(parent);
  const clone = join(parent, "app");
  git(parent, "clone", "-q", upstream, clone);
  git(clone, "branch", "beta");
  git(clone, "branch", "local-only");
  return { upstream, clone };
}

describe("listBranches", () => {
  test("local branches plus origin's without a local one, deduped, sorted case-insensitively, the default selected", () => {
    const { clone } = cloned();
    const list = listBranches(clone);
    expect(list.branches).toEqual([
      { name: "alpha", ref: "origin/alpha", remote: true },
      { name: "beta", ref: "beta", remote: false },
      { name: "feature/x", ref: "origin/feature/x", remote: true },
      { name: "local-only", ref: "local-only", remote: false },
      { name: "main", ref: "main", remote: false }, // local and on origin: once, as the local one
      { name: "Zeta", ref: "origin/Zeta", remote: true },
    ]);
    expect(list.default).toBe("main");
    expect(list.selected).toBe("main");
  });

  test("a default branch only on origin is selected as its origin entry", () => {
    const { clone } = cloned();
    git(clone, "checkout", "-q", "beta");
    git(clone, "branch", "-q", "-D", "main");
    const list = listBranches(clone);
    expect(list.branches.find((b) => b.name === "main")).toEqual({ name: "main", ref: "origin/main", remote: true });
    expect(list.selected).toBe("origin/main");
  });

  test("a repo with no origin and no default branch lists its branches with nothing selected", () => {
    const repo = tempRepo("solo");
    dirs.push(repo);
    git(repo, "checkout", "-q", "-b", "trunk");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "first");
    git(repo, "branch", "B");
    git(repo, "branch", "a");
    const list = listBranches(repo);
    expect(list.branches.map((b) => b.ref)).toEqual(["a", "B", "trunk"]);
    expect(list.default).toBe(null);
    expect(list.selected).toBe(null);
  });
});

describe("hcoord lane branches", () => {
  test("--json prints the list; plain text marks the default; lane new takes a remote-only entry's ref as --base", async () => {
    const { clone } = cloned();
    const home = tempDir("home");
    const user = tempDir("user");
    dirs.push(home, user);
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, agent: { kind: "generic", command: ["true"] } }));
    const env = { ...process.env, HOME: user };
    const ok = async (...args: string[]) => {
      const r = await cli(home, args, undefined, env);
      if (r.code !== 0) throw new Error(`hcoord ${args.join(" ")} → ${r.code}:\n${r.stdout}${r.stderr}`);
      return r.stdout;
    };
    await ok("project", "new", "app", "--repo", clone, "--prefix", "AP");

    const list = JSON.parse(await ok("lane", "branches", "app", "--json"));
    expect(list.selected).toBe("main");
    expect(list.branches.map((b: any) => b.ref)).toEqual(["origin/alpha", "beta", "origin/feature/x", "local-only", "main", "origin/Zeta"]);
    expect((await ok("lane", "branches", "app")).split("\n")).toContain("* main");

    // The ref the list gives a remote-only branch is one lane new can start from.
    const made = JSON.parse(await ok("lane", "new", "from-alpha", "app", "--base", "origin/alpha", "--json"));
    expect(made.base).toBe("origin/alpha");
    expect(git(made.path, "rev-parse", "HEAD")).toBe(git(clone, "rev-parse", "origin/alpha"));
  });
});
