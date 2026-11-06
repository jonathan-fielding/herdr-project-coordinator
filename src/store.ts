import { appendFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ensureRoot } from "./config.ts";
import { HcoordError } from "./errors.ts";
import { assertCanGitInit, filesToCommit, gitInit, insideGitRepo } from "./git.ts";
import { atomicWrite, readJson, withLock } from "./fsutil.ts";
import { branchFor, defaultPrefix, PREFIX_RE, ROOT_LANE, slugify, type Task, type TaskState } from "./model.ts";
import { paths } from "./paths.ts";
import { renderTasksMd } from "./render.ts";

/** A coordinator agent: its hc terminal and Claude session. */
export interface CoordinatorRef {
  address: string;
  name: string;
  /** Claude session id: its transcript, and what recovery resumes. */
  session?: string;
}

/** A worktree's removal, waiting for its cleanup task to be merged. */
export interface PendingRemoval {
  /** The cleanup task's id. */
  task: string;
  /** Remove it even with uncommitted changes. */
  force: boolean;
  since: string;
}

/** A checkout of the project's repo that has (or had) a coordinator: the main one ("root") or a worktree. */
export interface Lane {
  /** Absolute path of the checkout. */
  path: string;
  /** Its branch when registered (the live one can differ). Null: detached or unknown. */
  branch: string | null;
  coordinator?: CoordinatorRef;
  removing?: PendingRemoval;
  createdAt: string;
}

/** Machine-readable project facts (PROJECT.md is the human-edited half). */
export interface ProjectMeta {
  version: 1;
  slug: string;
  name: string;
  /** Task id prefix, unique across projects, e.g. "QHQ". */
  prefix: string;
  /** Absolute path of the repo's main checkout. A project is one repo. */
  repo: string;
  /** Worktrees by key ("root" = the main checkout). */
  lanes: Record<string, Lane>;
  createdAt: string;
}

/** Project files written before worktrees: `repos` → `repo`, one project coordinator → none (it ran outside the repo). */
function normalizeMeta(raw: any): ProjectMeta {
  const repo: string = raw.repo ?? raw.repos?.[0];
  const lanes: Record<string, Lane> = raw.lanes ?? {};
  lanes[ROOT_LANE] ??= { path: repo, branch: null, createdAt: raw.createdAt };
  const { repos: _r, coordinator: _c, ...rest } = raw;
  return { ...rest, repo, lanes };
}

function normalizeTasks(file: TaskFile): TaskFile {
  for (const t of file.tasks) t.lane ??= ROOT_LANE;
  return file;
}

export interface TaskFile {
  version: 1;
  nextId: number;
  tasks: Task[];
}

export interface EventRecord {
  ts: string;
  project: string;
  type: string;
  task?: string;
  from?: TaskState;
  to?: TaskState;
  data?: Record<string, unknown>;
}

export type NewEvent = Omit<EventRecord, "ts" | "project">;

const now = () => new Date().toISOString();

function appendEvents(slug: string, ts: string, events: NewEvent[]): void {
  if (!events.length) return;
  // One append call per mutation; O_APPEND keeps concurrent lines whole.
  const text = events.map((e) => JSON.stringify({ ts, project: slug, ...e }) + "\n").join("");
  appendFileSync(paths.eventsLog(slug), text);
}

function writeTasks(meta: ProjectMeta, file: TaskFile): void {
  atomicWrite(paths.tasksJson(meta.slug), JSON.stringify(file, null, 2) + "\n");
  atomicWrite(paths.tasksMd(meta.slug), renderTasksMd(meta, file));
}

// ---------------------------------------------------------------- projects

export function listProjects(): ProjectMeta[] {
  if (!existsSync(paths.projects())) return [];
  return readdirSync(paths.projects(), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(paths.projectJson(d.name)))
    .map((d) => normalizeMeta(readJson<ProjectMeta>(paths.projectJson(d.name))))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Loads a project by slug, or by its task prefix ("qhq" → the project whose ids are QHQ-n). */
export function loadProject(slug: string): ProjectMeta {
  if (!existsSync(paths.projectJson(slug))) {
    const byPrefix = listProjects().find((p) => p.prefix === slug.toUpperCase());
    if (byPrefix) return byPrefix;
    const known = listProjects().map((p) => p.slug);
    throw new HcoordError(
      `no project "${slug}"` + (known.length ? ` (projects: ${known.join(", ")})` : " (none yet: hcoord project new)"),
    );
  }
  return normalizeMeta(readJson<ProjectMeta>(paths.projectJson(slug)));
}

function writeMeta(meta: ProjectMeta): void {
  atomicWrite(paths.projectJson(meta.slug), JSON.stringify(meta, null, 2) + "\n");
}

/** Changes project.json under the project lock (re-read inside it). */
export async function updateMeta<T>(project: string, fn: (meta: ProjectMeta) => { result: T; event?: NewEvent }): Promise<T> {
  const slug = loadProject(project).slug;
  return withLock(paths.lock(slug), () => {
    const meta = loadProject(slug);
    const { result, event } = fn(meta);
    writeMeta(meta);
    if (event) appendEvents(slug, now(), [event]);
    return result;
  });
}

/** The project whose repo is `repo` (a main checkout), if any. */
export function projectForRepo(repo: string): ProjectMeta | null {
  return listProjects().find((p) => p.repo === repo) ?? null;
}

/** The project to use when none is named: $HCOORD_PROJECT, else the only one. */
export function defaultProjectSlug(): string {
  const env = process.env.HCOORD_PROJECT;
  if (env) return env;
  const all = listProjects();
  if (all.length === 1) return all[0]!.slug;
  throw new HcoordError(
    all.length ? `name a project (${all.map((p) => p.slug).join(", ")})` : "no projects yet: hcoord project new",
    2,
  );
}

/** Resolves a path to the root of the git checkout containing it (a worktree's own root for a worktree). */
export function gitRoot(path: string): string {
  return checkoutOf(path).top;
}

/**
 * The checkout containing `path`: its root (`top`), the repo's main checkout (`main`; the same as
 * `top` unless it's a linked worktree) and its branch (null when detached).
 */
export function checkoutOf(path: string): { top: string; main: string; branch: string | null } {
  if (!existsSync(path)) throw new HcoordError(`no such folder: ${path}`);
  const r = Bun.spawnSync(
    ["git", "-C", path, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--abbrev-ref", "HEAD"],
    { stderr: "pipe" },
  );
  if (r.exitCode !== 0) {
    // A repo with no commit yet has no HEAD to name; ask for the rest alone.
    const r2 = Bun.spawnSync(["git", "-C", path, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], { stderr: "pipe" });
    if (r2.exitCode !== 0) throw new HcoordError(`not a git repository: ${path}`);
    const [top, common] = r2.stdout.toString().trim().split("\n");
    return { top: realpathSync(top!), main: mainOf(common!, top!), branch: null };
  }
  const [top, common, head] = r.stdout.toString().trim().split("\n");
  return { top: realpathSync(top!), main: mainOf(common!, top!), branch: head && head !== "HEAD" ? head : null };
}

function mainOf(common: string, top: string): string {
  // The common git dir is <main>/.git for a normal repo; a bare repo has no main checkout.
  return common.endsWith("/.git") ? realpathSync(common.slice(0, -5)) : realpathSync(top);
}

function projectMdStub(meta: ProjectMeta): string {
  return [
    `# ${meta.name}`,
    "",
    "## Repo",
    "",
    `- ${meta.repo}`,
    "",
    "## Standing instructions",
    "",
    "<!-- Written once by hcoord; yours to edit. The coordinator reads this every turn.",
    "     E.g. how to run tests, code style, areas not to touch, who reviews. -->",
    "",
  ].join("\n");
}

export interface NewProject {
  name: string;
  repo: string;
  prefix?: string;
  /** Make a plain folder a repo with a first commit. Changes nothing for one already in a repo. */
  gitInit?: boolean;
}

/** Every check that can refuse a new project and doesn't need the root lock. Changes nothing. */
function planProject(opts: NewProject) {
  const name = opts.name.trim();
  const slug = slugify(name);
  if (!slug) throw new HcoordError(`can't make a folder name from "${opts.name}"`, 2);
  const init = !!opts.gitInit && !insideGitRepo(opts.repo);
  if (init) assertCanGitInit(opts.repo);
  // A worktree's path names its repo: the project is the main checkout.
  const repo = init ? realpathSync(opts.repo) : checkoutOf(opts.repo).main;
  const prefix = (opts.prefix ?? defaultPrefix(name)).toUpperCase();
  if (!PREFIX_RE.test(prefix)) {
    throw new HcoordError(`prefix "${prefix}" must be 2-8 letters/digits starting with a letter (use --prefix)`, 2);
  }
  return { name, slug, prefix, repo, init };
}

function assertProjectFree(slug: string, prefix: string, repo: string): void {
  if (existsSync(paths.project(slug))) throw new HcoordError(`project "${slug}" already exists`);
  const clash = listProjects().find((p) => p.prefix === prefix);
  if (clash) throw new HcoordError(`prefix ${prefix} is used by "${clash.slug}"; pick another with --prefix`);
  const same = listProjects().find((p) => p.repo === repo);
  if (same) throw new HcoordError(`${repo} is already project "${same.slug}"`);
}

/** What `project new --git-init --dry-run` reports. */
export interface GitInitPreview {
  repo: string;
  /** Whether a real run would init; false for a folder already in a repo. */
  gitInit: boolean;
  /** Relative paths the first commit would hold, at most GIT_INIT_PREVIEW_FILES of them. */
  files: string[];
  /** All of them, however many `files` shows. */
  count: number;
  hasGitignore: boolean;
}

const GIT_INIT_PREVIEW_FILES = 200;

/** What createProject with gitInit would do, refusing what it would refuse. Changes nothing. */
export function previewGitInit(opts: NewProject): GitInitPreview {
  const { slug, prefix, repo, init } = planProject({ ...opts, gitInit: true });
  assertProjectFree(slug, prefix, repo);
  const files = init ? filesToCommit(repo) : [];
  return {
    repo,
    gitInit: init,
    files: files.slice(0, GIT_INIT_PREVIEW_FILES),
    count: files.length,
    hasGitignore: existsSync(join(repo, ".gitignore")),
  };
}

export async function createProject(opts: NewProject): Promise<ProjectMeta> {
  const { name, slug, prefix, repo, init } = planProject(opts);
  ensureRoot();
  return withLock(paths.rootLock(), () => {
    assertProjectFree(slug, prefix, repo);
    if (init) gitInit(repo);
    const branch = checkoutOf(repo).branch;
    const createdAt = now();
    const meta: ProjectMeta = {
      version: 1, slug, name, prefix, repo,
      lanes: { [ROOT_LANE]: { path: repo, branch, createdAt } },
      createdAt,
    };
    mkdirSync(paths.reports(slug), { recursive: true });
    atomicWrite(paths.projectMd(slug), projectMdStub(meta));
    atomicWrite(paths.memoryMd(slug), `# ${name}: coordinator memory\n\n`);
    writeTasks(meta, { version: 1, nextId: 1, tasks: [] });
    // project.json last: a project only "exists" (listProjects) once everything else is there.
    atomicWrite(paths.projectJson(slug), JSON.stringify(meta, null, 2) + "\n");
    appendEvents(slug, meta.createdAt, [{ type: "project.created", data: { name, prefix, repo } }]);
    return meta;
  });
}

// ---------------------------------------------------------------- tasks

export function loadTasks(slug: string): TaskFile {
  return normalizeTasks(readJson<TaskFile>(paths.tasksJson(slug)));
}

/** Finds a task by id ("QHQ-12", any case) across projects, using its prefix. */
export function findTask(id: string): { meta: ProjectMeta; task: Task } {
  const norm = id.trim().toUpperCase();
  const prefix = norm.slice(0, norm.lastIndexOf("-"));
  const meta = listProjects().find((p) => p.prefix === prefix);
  if (!meta) throw new HcoordError(`no project has task prefix "${prefix || norm}"`);
  const task = loadTasks(meta.slug).tasks.find((t) => t.id === norm);
  if (!task) throw new HcoordError(`no task ${norm} in "${meta.slug}"`);
  return { meta, task };
}

export interface MutationContext {
  meta: ProjectMeta;
  file: TaskFile;
  /** One timestamp for the whole mutation. */
  now: string;
}

/**
 * The only way task state changes: takes the project lock, re-reads tasks.json, lets `fn` change it
 * and name its events, then writes tasks.json + TASKS.md atomically and appends to events.log.
 * If `fn` throws, nothing is written.
 */
export async function mutate<T>(
  project: string,
  fn: (ctx: MutationContext) => { result: T; events: NewEvent[] },
): Promise<T> {
  const meta = loadProject(project);
  const slug = meta.slug;
  return withLock(paths.lock(slug), () => {
    const ctx: MutationContext = { meta, file: loadTasks(slug), now: now() };
    const before = JSON.stringify(ctx.file);
    const { result, events } = fn(ctx);
    // Nothing changed, nothing written: folder watchers (the Herdr section) don't wake for no reason.
    if (!events.length && JSON.stringify(ctx.file) === before) return result;
    writeTasks(meta, ctx.file);
    appendEvents(slug, ctx.now, events);
    return result;
  });
}

export interface NewTask {
  title: string;
  brief: string;
  dependsOn?: string[];
  /** The worktree it belongs to; default $HCOORD_LANE, else the main checkout. */
  lane?: string;
  cleanup?: boolean;
}

/** A new todo task at the end of `file`, and the event for it. */
function appendTask(meta: ProjectMeta, file: TaskFile, input: NewTask & { lane: string }, now: string): { task: Task; event: NewEvent } {
  const id = `${meta.prefix}-${file.nextId}`;
  file.nextId += 1;
  const dependsOn = input.dependsOn ?? [];
  const task: Task = {
    id,
    title: input.title,
    brief: input.brief,
    state: "todo",
    repo: meta.repo,
    lane: input.lane,
    branch: branchFor(id, input.title, input.lane),
    dependsOn,
    ...(input.cleanup ? { cleanup: true } : {}),
    createdAt: now,
    updatedAt: now,
  };
  file.tasks.push(task);
  return { task, event: { type: "task.created", task: id, to: "todo", data: { title: input.title, dependsOn } } };
}

export async function addTask(slug: string, input: NewTask): Promise<Task> {
  const title = input.title.trim();
  if (!title) throw new HcoordError("--title is empty", 2);
  if (!input.brief.trim()) throw new HcoordError("the brief is empty", 2);
  const deps = [...new Set((input.dependsOn ?? []).map((d) => d.trim().toUpperCase()).filter(Boolean))];
  const lane = input.lane ?? (process.env.HCOORD_LANE || ROOT_LANE);

  return mutate(slug, ({ meta, file, now }) => {
    if (!meta.lanes[lane]) {
      throw new HcoordError(`${slug} has no worktree "${lane}" (it has: ${Object.keys(meta.lanes).join(", ")})`);
    }
    const known = new Set(file.tasks.map((t) => t.id));
    const missing = deps.filter((d) => !known.has(d));
    if (missing.length) throw new HcoordError(`unknown task${missing.length > 1 ? "s" : ""} in --depends-on: ${missing.join(", ")}`);

    const { task, event } = appendTask(meta, file, { title, brief: input.brief, dependsOn: deps, lane }, now);
    return { result: task, events: [event] };
  });
}

/**
 * Records a worktree's pending removal and adds its cleanup task, under one lock so that two deletes
 * can't add two tasks. With a removal pending already, returns its task; a `force` now stands too.
 * A pending removal whose task was cancelled doesn't count.
 */
export async function beginRemoval(project: string, lane: string, cleanup: { title: string; brief: string }, force: boolean): Promise<Task> {
  return mutate(project, ({ meta: { slug }, file, now }) => {
    const meta = loadProject(slug); // mutate read its copy before taking the lock.
    const l = meta.lanes[lane];
    if (!l) throw new HcoordError(`${slug} has no worktree "${lane}"`);
    const pending = file.tasks.find((t) => t.id === l.removing?.task && t.state !== "cancelled");
    if (pending) {
      if (force && !l.removing!.force) {
        l.removing!.force = true;
        writeMeta(meta);
      }
      return { result: pending, events: [] };
    }
    const { task, event } = appendTask(meta, file, { ...cleanup, lane, cleanup: true }, now);
    l.removing = { task: task.id, force, since: now };
    writeMeta(meta);
    return { result: task, events: [event, { type: "lane.removing", task: task.id, data: { lane, path: l.path, force } }] };
  });
}

/** Forgets a worktree's pending removal, if it's still the one `task` holds up. Whether there was one. */
export async function clearRemoval(project: string, lane: string, task: string): Promise<boolean> {
  if (loadProject(project).lanes[lane]?.removing?.task !== task) return false;
  return updateMeta(project, (m) => {
    const l = m.lanes[lane];
    if (l?.removing?.task !== task) return { result: false };
    delete l.removing;
    return { result: true, event: { type: "lane.removal_cleared", task, data: { lane, path: l.path } } };
  });
}
