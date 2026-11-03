import { basename, join } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
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

/**
 * The repo's default branch: what origin/HEAD points at, else init.defaultBranch, main or master
 * when that branch exists (locally or on origin). null when none can be told.
 */
export function defaultBranch(repo: string): string | null {
  const head = git(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head.code === 0 && head.out.startsWith("origin/")) return head.out.slice("origin/".length);
  const configured = git(repo, ["config", "--get", "init.defaultBranch"]).out;
  for (const b of [configured, "main", "master"]) {
    if (b && (branchExists(repo, b) || remoteBranchExists(repo, b))) return b;
  }
  return null;
}

function remoteBranchExists(repo: string, branch: string): boolean {
  return git(repo, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).code === 0;
}

/** Where Herdr's New worktree puts a branch's checkout: ~/.herdr/worktrees/<repo>/<branch>. */
export function herdrWorktreePath(repo: string, branch: string, home = process.env.HOME || homedir()): string {
  const slug = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return join(home, ".herdr", "worktrees", basename(repo), slug);
}

/**
 * A checkout of an existing branch: the one git already has, else a new worktree where Herdr
 * would make it. A branch only on origin gets a local branch tracking it. Never makes a new branch
 * from nothing, never forced.
 */
export function checkoutBranch(repo: string, branch: string): { path: string; created: boolean } {
  const have = listWorktrees(repo).find((w) => w.branch === branch);
  if (have) return { path: have.path, created: false };
  const path = herdrWorktreePath(repo, branch);
  if (existsSync(path)) throw new HcoordError(`${path} exists but isn't a checkout of ${branch}; move it away first`);
  if (branchExists(repo, branch)) gitOk(repo, ["worktree", "add", path, branch], `checking out ${branch}`);
  else if (remoteBranchExists(repo, branch)) {
    gitOk(repo, ["worktree", "add", "--track", "-b", branch, path, `origin/${branch}`], `checking out ${branch}`);
  } else throw new HcoordError(`no branch ${branch} in ${repo} (or on origin)`);
  return { path: realpathSync(path), created: true };
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
 * Makes (or reuses) a worktree at `path` on `branch`. A new branch starts from `from`'s HEAD (a
 * checkout of the same repo: the task's worktree). Returns the commit it is based on.
 */
export function ensureWorktree(repo: string, path: string, branch: string, from = repo): { base: string; reused: boolean } {
  const base = gitOk(from, ["rev-parse", "HEAD"], `reading HEAD of ${from} (does it have a commit?)`);
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

/** Commits on HEAD since `base`, newest first, one line each ("" if none or unknown). */
export function commitsSince(path: string, base: string): string {
  const r = git(path, ["log", "--oneline", "--no-decorate", `${base}..HEAD`]);
  return r.code === 0 ? r.out : "";
}

/** Uncommitted or untracked files in a worktree ("" = clean). */
export function dirtyFiles(path: string): string {
  return gitOk(path, ["status", "--porcelain"], `checking ${path}`);
}

/** The branch checked out at `repo` (any checkout), and whether `branch` is fully merged into it. */
export function mergedInto(repo: string, branch: string): { target: string; merged: boolean } {
  const target = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).out || "HEAD";
  const r = git(repo, ["merge-base", "--is-ancestor", branch, "HEAD"]);
  if (r.code > 1) throw new HcoordError(`checking whether ${branch} is merged: ${r.err}`);
  return { target, merged: r.code === 0 };
}

/**
 * Merges `branch` into whatever `checkout` has checked out (`git merge --no-ff --no-edit`).
 * On a conflict the merge is aborted, leaving the checkout as it was. Never forced. A branch with
 * nothing new on it is `nothing: true` and changes nothing.
 */
export function mergeBranch(
  checkout: string,
  branch: string,
): { ok: true; commit: string; into: string; nothing?: boolean } | { ok: false; error: string } {
  const into = git(checkout, ["rev-parse", "--abbrev-ref", "HEAD"]).out || "HEAD";
  if (into === "HEAD") return { ok: false, error: `${checkout} is on a detached HEAD; check out a branch to merge into` };
  // Nothing on the branch that isn't already there (no commits made): say so rather than "merged".
  const already = git(checkout, ["merge-base", "--is-ancestor", branch, "HEAD"]);
  if (already.code === 0) return { ok: true, commit: git(checkout, ["rev-parse", "--short", "HEAD"]).out, into, nothing: true };
  if (existsSync(join(gitDir(checkout), "MERGE_HEAD"))) return { ok: false, error: `${checkout} is in the middle of another merge` };
  const r = git(checkout, ["-c", "user.name=hcoord", "-c", "user.email=hcoord@localhost", "merge", "--no-ff", "--no-edit", branch]);
  if (r.code === 0) return { ok: true, commit: git(checkout, ["rev-parse", "--short", "HEAD"]).out, into };
  const conflicts = git(checkout, ["diff", "--name-only", "--diff-filter=U"]).out;
  if (existsSync(join(gitDir(checkout), "MERGE_HEAD"))) git(checkout, ["merge", "--abort"]);
  const why = conflicts
    ? `conflicts in ${conflicts.split("\n").join(", ")}`
    : (r.err || r.out).split("\n").filter(Boolean).slice(0, 4).join(" ");
  return { ok: false, error: `merging ${branch} into ${into} failed (${why}); nothing was changed` };
}

function gitDir(checkout: string): string {
  return git(checkout, ["rev-parse", "--path-format=absolute", "--git-dir"]).out;
}

/** Removes a worktree. Never forced; the branch is kept. */
export function removeWorktree(repo: string, path: string): void {
  gitOk(repo, ["worktree", "remove", path], `removing worktree ${path}`);
}
