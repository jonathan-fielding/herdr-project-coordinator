import { existsSync, realpathSync } from "node:fs";
import { HcoordError } from "./errors.ts";

function git(cwd: string, args: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  return { code: r.exitCode ?? 1, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

function gitOk(cwd: string, args: string[], what: string): string {
  const r = git(cwd, args);
  if (r.code !== 0) throw new HcoordError(`${what}: ${r.err || r.out || `git exit ${r.code}`}`);
  return r.out;
}

export function branchExists(repo: string, branch: string): boolean {
  return git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0;
}

/** Worktree paths (realpath'd) and their branches. */
export function listWorktrees(repo: string): { path: string; branch: string | null }[] {
  const out = gitOk(repo, ["worktree", "list", "--porcelain"], "listing worktrees");
  const result: { path: string; branch: string | null }[] = [];
  for (const block of out.split("\n\n")) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (!path) continue;
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null;
    result.push({ path: existsSync(path) ? realpathSync(path) : path, branch });
  }
  return result;
}

/**
 * Makes (or reuses) a worktree at `path` on `branch`. A new branch starts from the repo's HEAD.
 * Returns the commit it is based on.
 */
export function ensureWorktree(repo: string, path: string, branch: string): { base: string; reused: boolean } {
  const base = gitOk(repo, ["rev-parse", "HEAD"], `reading HEAD of ${repo} (does it have a commit?)`);
  const real = existsSync(path) ? realpathSync(path) : path;
  const existing = listWorktrees(repo).find((w) => w.path === real);
  if (existing) {
    if (existing.branch !== branch) {
      throw new HcoordError(`${path} is already a worktree on ${existing.branch ?? "a detached HEAD"}, not ${branch}`);
    }
    return { base, reused: true };
  }
  if (existsSync(path)) throw new HcoordError(`${path} exists and isn't a worktree of ${repo}; move it away first`);
  const args = branchExists(repo, branch)
    ? ["worktree", "add", path, branch]
    : ["worktree", "add", "-b", branch, path, base];
  gitOk(repo, args, `creating worktree ${path}`);
  return { base, reused: false };
}

/** Uncommitted or untracked files in a worktree ("" = clean). */
/** Commits on HEAD since \`base\`, newest first, one line each ("" if none or unknown). */
export function commitsSince(path: string, base: string): string {
  const r = git(path, ["log", "--oneline", "--no-decorate", `${base}..HEAD`]);
  return r.code === 0 ? r.out : "";
}

export function dirtyFiles(path: string): string {
  return gitOk(path, ["status", "--porcelain"], `checking ${path}`);
}

/** The branch checked out in the main repo, and whether `branch` is fully merged into it. */
export function mergedInto(repo: string, branch: string): { target: string; merged: boolean } {
  const target = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).out || "HEAD";
  const r = git(repo, ["merge-base", "--is-ancestor", branch, "HEAD"]);
  if (r.code > 1) throw new HcoordError(`checking whether ${branch} is merged: ${r.err}`);
  return { target, merged: r.code === 0 };
}

/** Removes a worktree. Never forced; the branch is kept. */
export function removeWorktree(repo: string, path: string): void {
  gitOk(repo, ["worktree", "remove", path], `removing worktree ${path}`);
}
