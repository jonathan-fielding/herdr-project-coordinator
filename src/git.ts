import { basename, join } from "node:path";
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

export interface BranchChoice {
  /** The branch's name, as a person reads it ("main", "fix/login"). */
  name: string;
  /** What git resolves: the name for a local branch, origin/<name> for one only on origin. */
  ref: string;
  /** Only on origin (no local branch of that name). */
  remote: boolean;
}

/**
 * Branches a new one can start from: the local ones, plus origin's that have no local branch of
 * the same name, sorted by name (case-insensitive). `selected` is the default branch's entry
 * (its origin entry when it is only there), else null.
 */
export function listBranches(repo: string): { default: string | null; selected: string | null; branches: BranchChoice[] } {
  const out = gitOk(repo, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"], "listing branches");
  const byName = new Map<string, BranchChoice>();
  const remote: string[] = [];
  for (const ref of out.split("\n").filter(Boolean)) {
    if (ref.startsWith("refs/heads/")) {
      const name = ref.slice("refs/heads/".length);
      byName.set(name, { name, ref: name, remote: false });
    } else remote.push(ref.slice("refs/remotes/origin/".length));
  }
  for (const name of remote) {
    if (name === "HEAD" || byName.has(name)) continue;
    byName.set(name, { name, ref: `origin/${name}`, remote: true });
  }
  const branches = [...byName.values()].sort((a, b) => {
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const def = defaultBranch(repo);
  const selected = def ? (byName.get(def)?.ref ?? null) : null;
  return { default: def, selected, branches };
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
export function checkoutBranch(repo: string, branch: string): { path: string; created: boolean; warnings: string[] } {
  const warnings: string[] = [];
  const have = listWorktrees(repo).find((w) => w.branch === branch);
  if (have) return { path: have.path, created: false, warnings };
  const path = herdrWorktreePath(repo, branch);
  if (existsSync(path)) throw new HcoordError(`${path} exists but isn't a checkout of ${branch}; move it away first`);
  // About to track origin's: bring it up to date first (and find one pushed since the last fetch).
  if (!branchExists(repo, branch)) {
    const w = fetchBranch(repo, branch);
    if (w) warnings.push(w);
  }
  if (branchExists(repo, branch)) gitOk(repo, ["worktree", "add", path, branch], `checking out ${branch}`);
  else if (remoteBranchExists(repo, branch)) {
    gitOk(repo, ["worktree", "add", "--track", "-b", branch, path, `origin/${branch}`], `checking out ${branch}`);
  } else throw new HcoordError(`no branch ${branch} in ${repo} (or on origin)`);
  return { path: realpathSync(path), created: true, warnings };
}

/** How long a fetch may take before hcoord gives up on it and carries on with what's local. */
const FETCH_TIMEOUT_MS = Number(process.env.HCOORD_FETCH_TIMEOUT_MS) || 15_000;

/**
 * Fetches `branch` from origin into refs/remotes/origin/<branch>, bounded by a timeout and never
 * prompting. Returns a one-line warning when the fetch failed for a branch origin is known to have,
 * null when it worked or there was nothing to fetch (no origin, or origin hasn't got the branch).
 */
export function fetchBranch(repo: string, branch: string): string | null {
  if (git(repo, ["remote", "get-url", "origin"]).code !== 0) return null;
  const known = remoteBranchExists(repo, branch);
  const r = Bun.spawnSync(
    ["git", "-C", repo, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      timeout: FETCH_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
    },
  );
  if (r.exitCode === 0) return null;
  if (!known) return null; // not on origin (a local-only branch, or no such branch): nothing to warn about
  const why = r.exitedDueToTimeout || r.signalCode
    ? `timed out after ${FETCH_TIMEOUT_MS / 1000}s`
    : r.stderr.toString().trim().split("\n").filter(Boolean)[0] || `git exit ${r.exitCode}`;
  return `couldn't fetch ${branch} from origin (${why}); using the local copy`;
}

function isAncestor(repo: string, a: string, b: string): boolean {
  return git(repo, ["merge-base", "--is-ancestor", a, b]).code === 0;
}

/**
 * Where a new branch based on `from` should really start, after fetching origin's copy of it.
 * A branch behind origin's (local is an ancestor) is fast-forwarded when nothing has it checked
 * out, else origin's is used; a branch that is ahead or has diverged is used as it is. Anything
 * that isn't a branch (a commit, a tag, HEAD) is used as given.
 */
function freshBase(repo: string, from: string, warnings: string[]): string {
  let name: string;
  if (from.startsWith("origin/") && !branchExists(repo, from)) name = from.slice("origin/".length);
  else if (branchExists(repo, from) || remoteBranchExists(repo, from)) name = from;
  else if (git(repo, ["rev-parse", "--verify", "--quiet", `${from}^{commit}`]).code !== 0 && git(repo, ["check-ref-format", "--branch", from]).code === 0) {
    // Not anything git knows here: maybe a branch pushed to origin since the last fetch.
    fetchBranch(repo, from);
    return remoteBranchExists(repo, from) ? `origin/${from}` : from;
  } else return from;
  const w = fetchBranch(repo, name);
  if (w) warnings.push(w);
  if (from !== name) return from; // asked for origin/<name>: now fresh
  if (!branchExists(repo, name)) return remoteBranchExists(repo, name) ? `origin/${name}` : from;
  if (!remoteBranchExists(repo, name)) return name;
  const local = git(repo, ["rev-parse", `refs/heads/${name}`]).out;
  const remote = git(repo, ["rev-parse", `refs/remotes/origin/${name}`]).out;
  if (local === remote || !isAncestor(repo, local, remote)) return name; // up to date, ahead, or diverged
  if (!listWorktrees(repo).some((wt) => wt.branch === name)) {
    // Fast-forward (the old value guards against a race); fall back to origin's if that fails.
    if (git(repo, ["update-ref", "-m", "hcoord: fast-forward to origin", `refs/heads/${name}`, remote, local]).code === 0) return name;
  }
  return `origin/${name}`;
}

/**
 * A new branch and a worktree for it, where Herdr's New worktree would put it. The branch starts at
 * `base` (default: the repo's default branch, local else origin's, else the main checkout's HEAD)
 * and tracks nothing. A base that is a branch on origin is fetched first, so the branch starts from
 * up-to-date code (see freshBase); a failed fetch only warns. `base` in the result is what was
 * used. Refuses a bad branch name, a branch that exists, and a path that exists.
 */
export function newBranchWorktree(repo: string, branch: string, base?: string): { path: string; base: string; warnings: string[] } {
  if (!branch || git(repo, ["check-ref-format", "--branch", branch]).code !== 0 || branch.startsWith("-")) {
    throw new HcoordError(`${JSON.stringify(branch)} isn't a valid branch name`, 2);
  }
  if (branchExists(repo, branch)) {
    throw new HcoordError(`branch ${branch} already exists; to open it: hcoord lane checkout ${branch}`);
  }
  if (remoteBranchExists(repo, branch)) {
    throw new HcoordError(`branch ${branch} already exists on origin; to open it: hcoord lane checkout ${branch}`);
  }
  const path = herdrWorktreePath(repo, branch);
  if (existsSync(path)) throw new HcoordError(`${path} already exists; move it away or pick another branch name`);
  const warnings: string[] = [];
  let from = base;
  if (!from) {
    const def = defaultBranch(repo);
    from = def ? (branchExists(repo, def) ? def : `origin/${def}`) : "HEAD";
  }
  from = freshBase(repo, from, warnings);
  if (git(repo, ["rev-parse", "--verify", "--quiet", `${from}^{commit}`]).code !== 0) {
    throw new HcoordError(`no commit ${from} in ${repo} to start ${branch} from`);
  }
  gitOk(repo, ["worktree", "add", "--no-track", "-b", branch, path, from], `creating worktree for ${branch}`);
  return { path: realpathSync(path), base: from, warnings };
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

/** Whether git sees `path` as inside a repo (bare ones and the inside of a .git count). */
export function insideGitRepo(path: string): boolean {
  return git(path, ["rev-parse", "--git-dir"]).code === 0;
}

/** Refuses a folder gitInit can't start, without touching it. Only for a path not inside a repo. */
export function assertCanGitInit(path: string): void {
  if (!existsSync(path)) throw new HcoordError(`no such folder: ${path}`);
  if (!statSync(path).isDirectory()) throw new HcoordError(`not a folder: ${path}`);
  // Something git doesn't accept as a repo (an empty .git, a broken link). It isn't ours to reuse
  // or to clean up, so a failed run could never put it back.
  if (lstatSync(join(path, ".git"), { throwIfNoEntry: false })) {
    throw new HcoordError(`${join(path, ".git")} exists but isn't a working git repository; fix or move it first`);
  }
  // useConfigOnly: a commit would otherwise guess a name from the hostname and succeed.
  const who = ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"];
  if (who.some((v) => git(path, ["-c", "user.useConfigOnly=true", "var", v]).code !== 0)) {
    throw new HcoordError(
      `git has no identity to make the first commit with (user.name / user.email unset). Set it, then run this again:\n` +
        `  git config --global user.name "Your Name"\n` +
        `  git config --global user.email "you@example.com"`,
    );
  }
}

/**
 * Makes `path` a repo with a first commit of its files (.gitignore honoured), so worktrees can be
 * made from it; empty when there's nothing to commit. Call assertCanGitInit first: it is what makes
 * any .git here this run's own, and so safe to remove when a step fails.
 */
export function gitInit(path: string): void {
  try {
    gitOk(path, ["init", "--quiet"], `git init in ${path}`);
    gitOk(path, ["add", "-A"], `adding the files in ${path}`);
    gitOk(path, ["commit", "--quiet", "--allow-empty", "-m", "Initial commit"], `making the first commit in ${path}`);
  } catch (e) {
    rmSync(join(path, ".git"), { recursive: true, force: true });
    throw e;
  }
}

/**
 * The paths gitInit would commit, relative to `path`, sorted as git sorts them. Works it out against
 * a throwaway git dir outside the folder, which is left untouched. A nested repo shows as "sub/".
 */
export function filesToCommit(path: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "hcoord-git-init-"));
  const env = { ...process.env, GIT_DIR: join(dir, "git"), GIT_WORK_TREE: path, GIT_INDEX_FILE: join(dir, "index") };
  const run = (args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", path, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
    if (r.exitCode !== 0) throw new HcoordError(`listing the files in ${path}: ${r.stderr.toString().trim()}`);
    return r.stdout.toString();
  };
  try {
    run(["init", "--quiet"]); // templates can carry info/exclude: same ignores as the real init
    return run(["ls-files", "-z", "--others", "--exclude-standard"]).split("\0").filter(Boolean);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
