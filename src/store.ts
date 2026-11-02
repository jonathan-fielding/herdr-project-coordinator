import { appendFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { ensureRoot } from "./config.ts";
import { HcoordError } from "./errors.ts";
import { atomicWrite, readJson, withLock } from "./fsutil.ts";
import { branchFor, defaultPrefix, PREFIX_RE, slugify, type Task, type TaskState } from "./model.ts";
import { paths } from "./paths.ts";
import { renderTasksMd } from "./render.ts";

/** Machine-readable project facts (PROJECT.md is the human-edited half). */
export interface ProjectMeta {
  version: 1;
  slug: string;
  name: string;
  /** Task id prefix, unique across projects, e.g. "QHQ". */
  prefix: string;
  /** Absolute repo roots. The first is the default for new tasks. */
  repos: string[];
  createdAt: string;
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
    .map((d) => readJson<ProjectMeta>(paths.projectJson(d.name)))
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
  return readJson<ProjectMeta>(paths.projectJson(slug));
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

/** Resolves a path to the root of the git repo containing it. */
export function gitRoot(path: string): string {
  if (!existsSync(path)) throw new HcoordError(`no such folder: ${path}`);
  const r = Bun.spawnSync(["git", "-C", path, "rev-parse", "--show-toplevel"], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new HcoordError(`not a git repository: ${path}`);
  return realpathSync(r.stdout.toString().trim());
}

function projectMdStub(meta: ProjectMeta): string {
  return [
    `# ${meta.name}`,
    "",
    "## Repos",
    "",
    ...meta.repos.map((r) => `- ${r}`),
    "",
    "## Standing instructions",
    "",
    "<!-- Written once by hcoord; yours to edit. The coordinator reads this every turn.",
    "     E.g. how to run tests, code style, areas not to touch, who reviews. -->",
    "",
  ].join("\n");
}

export async function createProject(opts: { name: string; repos: string[]; prefix?: string }): Promise<ProjectMeta> {
  const name = opts.name.trim();
  const slug = slugify(name);
  if (!slug) throw new HcoordError(`can't make a folder name from "${opts.name}"`, 2);
  if (!opts.repos.length) throw new HcoordError("give at least one --repo", 2);
  const repos = [...new Set(opts.repos.map(gitRoot))];
  const prefix = (opts.prefix ?? defaultPrefix(name)).toUpperCase();
  if (!PREFIX_RE.test(prefix)) {
    throw new HcoordError(`prefix "${prefix}" must be 2-8 letters/digits starting with a letter (use --prefix)`, 2);
  }
  ensureRoot();
  return withLock(paths.rootLock(), () => {
    if (existsSync(paths.project(slug))) throw new HcoordError(`project "${slug}" already exists`);
    const clash = listProjects().find((p) => p.prefix === prefix);
    if (clash) throw new HcoordError(`prefix ${prefix} is used by "${clash.slug}"; pick another with --prefix`);
    const meta: ProjectMeta = { version: 1, slug, name, prefix, repos, createdAt: now() };
    mkdirSync(paths.reports(slug), { recursive: true });
    atomicWrite(paths.projectMd(slug), projectMdStub(meta));
    atomicWrite(paths.memoryMd(slug), `# ${name}: coordinator memory\n\n`);
    writeTasks(meta, { version: 1, nextId: 1, tasks: [] });
    // project.json last: a project only "exists" (listProjects) once everything else is there.
    atomicWrite(paths.projectJson(slug), JSON.stringify(meta, null, 2) + "\n");
    appendEvents(slug, meta.createdAt, [{ type: "project.created", data: { name, prefix, repos } }]);
    return meta;
  });
}

// ---------------------------------------------------------------- tasks

export function loadTasks(slug: string): TaskFile {
  return readJson<TaskFile>(paths.tasksJson(slug));
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
    const { result, events } = fn(ctx);
    writeTasks(meta, ctx.file);
    appendEvents(slug, ctx.now, events);
    return result;
  });
}

export interface NewTask {
  title: string;
  brief: string;
  dependsOn?: string[];
  /** Must be one of the project's repos; default: the first. */
  repo?: string;
}

export async function addTask(slug: string, input: NewTask): Promise<Task> {
  const title = input.title.trim();
  if (!title) throw new HcoordError("--title is empty", 2);
  if (!input.brief.trim()) throw new HcoordError("the brief is empty", 2);
  const deps = [...new Set((input.dependsOn ?? []).map((d) => d.trim().toUpperCase()).filter(Boolean))];
  const repoArg = input.repo ? gitRoot(input.repo) : undefined;

  return mutate(slug, ({ meta, file, now }) => {
    const repo = repoArg ?? meta.repos[0]!;
    if (!meta.repos.includes(repo)) {
      throw new HcoordError(`${repo} isn't one of ${slug}'s repos (${meta.repos.join(", ")})`);
    }
    const known = new Set(file.tasks.map((t) => t.id));
    const missing = deps.filter((d) => !known.has(d));
    if (missing.length) throw new HcoordError(`unknown task${missing.length > 1 ? "s" : ""} in --depends-on: ${missing.join(", ")}`);

    const id = `${meta.prefix}-${file.nextId}`;
    file.nextId += 1;
    const task: Task = {
      id,
      title,
      brief: input.brief,
      state: "todo",
      repo,
      branch: branchFor(id, title),
      dependsOn: deps,
      createdAt: now,
      updatedAt: now,
    };
    file.tasks.push(task);
    return {
      result: task,
      events: [{ type: "task.created", task: id, to: "todo", data: { title, dependsOn: deps } }],
    };
  });
}
