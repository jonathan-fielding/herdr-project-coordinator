#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { HcoordError, UsageError } from "./errors.ts";
import { isTaskState, type Task } from "./model.ts";
import { paths } from "./paths.ts";
import { byNumber } from "./render.ts";
import {
  addTask,
  createProject,
  defaultProjectSlug,
  findTask,
  listProjects,
  loadProject,
  loadTasks,
} from "./store.ts";
import {
  cancelTask,
  cleanTask,
  laneOf,
  mergeTask,
  retryTask,
  REPORT_STATES,
  replyTask,
  report,
  startTask,
  sync,
  trustWarnings,
  workerStopped,
  type Outcome,
  type ReportState,
} from "./workers.ts";
import { addMemory, laneForPath, openLane, recoverProject } from "./coordinator.ts";
import { renderLog } from "./log.ts";
import { depMet, ROOT_LANE } from "./model.ts";
import { board, type BoardProject } from "./board.ts";
import { installMod } from "./modinstall.ts";
import { deleteProject, planDeleteProject, planRemoveWorktree, removeWorktreeLane } from "./remove.ts";

const HELP = `hcoord ${pkg.version}: tasks and workers for a Herdr coordinator

A project is one git repo. Each of its worktrees (the main checkout is "root") has a coordinator
agent; its workers each get a branch and checkout of their own, merged back into the worktree when done.

Projects and worktrees
  hcoord project new <name> --repo <path> [--prefix ABC]
  hcoord project list [--json]
  hcoord project show [<slug>] [--json]
  hcoord project open [<slug>] [...]              the main checkout's coordinator (lane open for root)
  hcoord lane open [<path>] [--space <id>] [--no-show] [--restart] [--fresh]
                                                  start (or show) the coordinator of the worktree at
                                                  <path> (default: here), registering it the first time
  hcoord lane list [<slug>] [--json]
  hcoord lane remove <path> [--force] [--dry-run]  remove a linked worktree: its coordinator and
                                                  unfinished tasks stop, git worktree remove (--force:
                                                  even with uncommitted changes); its branch is kept
  hcoord project delete <slug> [--files] [--dry-run]
                                                  stop its agents and move its hcoord data to
                                                  deleted/; --files also deletes the repo and its
                                                  worktrees (to the Trash where macOS has trash)
  hcoord board [--json]                           every project and its tasks (read only)
  hcoord sync [<slug>]                            check workers, start queued tasks (all projects)
  hcoord recover [<slug>] [--no-show]             after a reboot: coordinators back, lost workers retried

Herdr
  hcoord mod install                              put the Projects section in ~/.config/herdr-app/mods/hcoord
  hcoord memory [<slug>] <text>                   add a dated note to its MEMORY.md

Tasks
  hcoord task add [<slug>] --title <text> (--brief-file <file|-> | --brief <text>)
                  [--depends-on ID[,ID...]]... [--lane <key>] [--json]
  hcoord task list [<slug>] [--lane <key> | --all-lanes] [--state <state>] [--json] [--no-sync]
  hcoord task show <id> [--json]
  hcoord log <id> | --lane <key> [<slug>] [--json]   an agent's log (its Claude transcript)

Workers
  hcoord task start <id> [--parent <terminal>]   worktree + worker (or queue it)
  hcoord task reply <id> (<text> | --file <file|->)   answer a needs_you worker
  hcoord task retry <id>                          a failed/cancelled task again, in its checkout
  hcoord task merge <id>                          merge a done task into its worktree again (after a conflict)
  hcoord task cancel <id>                         stop its worker, keep the worktree
  hcoord task clean <id>                          remove its checkout if clean and merged
  hcoord report <id> --state done|needs_you|failed --file <file|-> [--no-notify]
                                                  (run by workers)

task list first checks workers against herdr-core (a vanished or exited worker → failed,
a blocked one → needs_you) and starts queued tasks that can start; --no-sync skips that.
<slug> may be left out when $HCOORD_PROJECT is set or only one project exists; --lane defaults to
$HCOORD_LANE (set for coordinators), else "root" for task add and every worktree for task list.
Data: ${paths.projects()}  ($HCOORD_HOME overrides the root)
`;

type Opts = NonNullable<ParseArgsConfig["options"]>;

function parse(args: string[], options: Opts, maxPositionals: number) {
  let parsed;
  try {
    parsed = parseArgs({ args, options: { ...options, json: { type: "boolean" } }, allowPositionals: true, strict: true });
  } catch (e: any) {
    throw new UsageError(e.message);
  }
  if (parsed.positionals.length > maxPositionals) {
    throw new UsageError(`unexpected argument: ${parsed.positionals.slice(maxPositionals).join(" ")}`);
  }
  return parsed as { values: Record<string, any>; positionals: string[] };
}

const out = (s: string) => process.stdout.write(s.endsWith("\n") ? s : s + "\n");
const json = (v: unknown) => out(JSON.stringify(v, null, 2));

function taskRow(t: Task, all: Map<string, Task>, showLane = false): string {
  const waits = t.dependsOn.filter((d) => !depMet(all.get(d)));
  const lane = showLane ? `${t.lane.padEnd(14)} ` : "";
  const note = t.state === "done" && t.mergeError ? `  (not merged: ${t.mergeError})` : waits.length ? `  (after ${waits.join(", ")})` : "";
  return `${t.id.padEnd(9)} ${lane}${t.state.padEnd(10)} ${t.title}${note}`;
}

async function readBrief(values: Record<string, any>): Promise<string> {
  if (values.brief !== undefined && values["brief-file"] !== undefined) {
    throw new UsageError("use --brief or --brief-file, not both");
  }
  if (values.brief !== undefined) return values.brief;
  const file = values["brief-file"];
  if (file === undefined) throw new UsageError("--brief-file <file> (or - for stdin) or --brief <text> is required");
  return readFileArg(file);
}

async function main(argv: string[]): Promise<number> {
  const [group, cmd, ...rest] = argv;
  if (!group || ["help", "--help", "-h"].includes(group)) {
    out(HELP);
    return 0;
  }
  if (group === "--version" || group === "-V") {
    out(pkg.version);
    return 0;
  }
  if (cmd === "--help" || cmd === "-h" || rest.includes("--help") || rest.includes("-h")) {
    out(HELP);
    return 0;
  }

  switch (`${group} ${cmd ?? ""}`) {
    case "project new": {
      const { values, positionals } = parse(rest, { repo: { type: "string" }, prefix: { type: "string" } }, 1);
      if (!positionals[0] || !values.repo) throw new UsageError("hcoord project new <name> --repo <path>");
      const meta = await createProject({ name: positionals[0], repo: values.repo, prefix: values.prefix });
      if (values.json) json(meta);
      else out(`created ${meta.slug} (tasks ${meta.prefix}-n) at ${paths.project(meta.slug)}\nedit ${paths.projectMd(meta.slug)} to add standing instructions`);
      for (const w of trustWarnings(meta)) process.stderr.write(w + "\n");
      return 0;
    }
    case "project list": {
      const { values } = parse(rest, {}, 0);
      const all = listProjects();
      if (values.json) json(all);
      else if (!all.length) out("no projects yet: hcoord project new <name> --repo <path>");
      else for (const p of all) out(`${p.slug.padEnd(24)} ${p.prefix.padEnd(6)} ${p.repo}`);
      return 0;
    }
    case "project show": {
      const { values, positionals } = parse(rest, {}, 1);
      const meta = loadProject(positionals[0] ?? defaultProjectSlug());
      const tasks = loadTasks(meta.slug).tasks;
      const counts: Record<string, number> = {};
      for (const t of tasks) counts[t.state] = (counts[t.state] ?? 0) + 1;
      if (values.json) json({ ...meta, dir: paths.project(meta.slug), counts });
      else {
        out(`${meta.name} (${meta.slug}, tasks ${meta.prefix}-n)`);
        out(`folder:  ${paths.project(meta.slug)}`);
        out(`repo:    ${meta.repo}`);
        out(`worktrees: ${Object.keys(meta.lanes).join(", ")}`);
        out(`tasks:   ${tasks.length ? Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(", ") : "none"}`);
      }
      return 0;
    }
    case "project open": {
      const { positionals, values } = parse(
        rest,
        { "no-show": { type: "boolean" }, space: { type: "string" }, restart: { type: "boolean" }, fresh: { type: "boolean" } },
        1,
      );
      return report_(await openLane(positionals[0] ?? defaultProjectSlug(), ROOT_LANE, openOpts(values)));
    }
    case "lane open": {
      const { positionals, values } = parse(
        rest,
        { "no-show": { type: "boolean" }, space: { type: "string" }, restart: { type: "boolean" }, fresh: { type: "boolean" } },
        1,
      );
      const { meta, lane } = await laneForPath(positionals[0] ?? process.cwd());
      return report_(await openLane(meta.slug, lane, openOpts(values)));
    }
    case "lane remove": {
      const { positionals, values } = parse(rest, { force: { type: "boolean" }, "dry-run": { type: "boolean" } }, 1);
      const path = positionals[0] ?? process.cwd();
      if (values["dry-run"]) {
        const plan = planRemoveWorktree(path);
        if (values.json) json(plan);
        else out(`would remove ${plan.path}${plan.changed.length ? ` (${plan.changed.length} uncommitted files)` : ""}${plan.unfinished.length ? `; cancels ${plan.unfinished.join(", ")}` : ""}`);
        return 0;
      }
      return report_(await removeWorktreeLane(path, { force: values.force }));
    }
    case "project delete": {
      const { positionals, values } = parse(rest, { files: { type: "boolean" }, "dry-run": { type: "boolean" } }, 1);
      if (!positionals[0]) throw new UsageError("name the project to delete");
      if (values["dry-run"]) {
        const plan = planDeleteProject(positionals[0]);
        if (values.json) json(plan);
        else out(`would delete ${plan.name}${values.files ? ` and ${plan.checkouts.map((c) => c.path).join(", ")}` : ""}`);
        return 0;
      }
      return report_(await deleteProject(positionals[0], { files: values.files }));
    }
    case "lane list": {
      const { positionals, values } = parse(rest, {}, 1);
      const meta = loadProject(positionals[0] ?? defaultProjectSlug());
      if (values.json) json(meta.lanes);
      else for (const [k, l] of Object.entries(meta.lanes)) {
        out(`${k.padEnd(24)} ${(l.branch ?? "-").padEnd(24)} ${l.path}${l.coordinator ? `  (${l.coordinator.name} ${l.coordinator.address})` : ""}`);
      }
      return 0;
    }
    case "task add": {
      const { values, positionals } = parse(
        rest,
        {
          title: { type: "string" },
          brief: { type: "string" },
          "brief-file": { type: "string" },
          "depends-on": { type: "string", multiple: true },
          lane: { type: "string" },
        },
        1,
      );
      if (values.title === undefined) throw new UsageError("--title is required");
      const slug = positionals[0] ?? defaultProjectSlug();
      const brief = await readBrief(values);
      const dependsOn = ((values["depends-on"] as string[] | undefined) ?? []).flatMap((d) => d.split(/[,\s]+/));
      const task = await addTask(slug, { title: values.title, brief, dependsOn, lane: values.lane });
      if (values.json) json(task);
      else out(task.id);
      return 0;
    }
    case "task start": {
      const { values, positionals } = parse(rest, { parent: { type: "string" } }, 1);
      if (!positionals[0]) throw new UsageError("hcoord task start <id>");
      return report_(await startTask(positionals[0], { parent: values.parent }));
    }
    case "task reply": {
      const { values, positionals } = parse(rest, { file: { type: "string" } }, Infinity);
      const [id, ...words] = positionals;
      if (!id) throw new UsageError("hcoord task reply <id> <text>");
      if (words.length && values.file !== undefined) throw new UsageError("give the reply as text or --file, not both");
      const text = values.file !== undefined ? await readFileArg(values.file) : words.join(" ");
      return report_(await replyTask(id, text));
    }
    case "task retry": {
      const { values, positionals } = parse(rest, { parent: { type: "string" } }, 1);
      if (!positionals[0]) throw new UsageError("hcoord task retry <id>");
      return report_(await retryTask(positionals[0], { parent: values.parent }));
    }
    case "task merge": {
      const { positionals } = parse(rest, {}, 1);
      if (!positionals[0]) throw new UsageError("hcoord task merge <id>");
      return report_(await mergeTask(positionals[0]));
    }
    case "task cancel": {
      const { positionals } = parse(rest, {}, 1);
      if (!positionals[0]) throw new UsageError("hcoord task cancel <id>");
      return report_(await cancelTask(positionals[0]));
    }
    case "task clean": {
      const { positionals } = parse(rest, {}, 1);
      if (!positionals[0]) throw new UsageError("hcoord task clean <id>");
      return report_(await cleanTask(positionals[0]));
    }
    case "task list": {
      const { values, positionals } = parse(
        rest,
        { state: { type: "string" }, "no-sync": { type: "boolean" }, lane: { type: "string" }, "all-lanes": { type: "boolean" } },
        1,
      );
      if (values.state !== undefined && !isTaskState(values.state)) throw new UsageError(`unknown state: ${values.state}`);
      const meta = loadProject(positionals[0] ?? defaultProjectSlug());
      const slug = meta.slug;
      const lane: string | undefined = values["all-lanes"] ? undefined : (values.lane ?? (process.env.HCOORD_LANE || undefined));
      if (lane) laneOf(meta, lane);
      if (!values["no-sync"]) {
        // Changes go to stderr so --json output stays parseable.
        for (const l of (await sync(slug)).lines) process.stderr.write(l + "\n");
      }
      const tasks = loadTasks(slug).tasks.sort(byNumber);
      const shown = tasks.filter((t) => (!values.state || t.state === values.state) && (!lane || t.lane === lane));
      if (values.json) json(shown);
      else if (!shown.length) out(values.state ? `no ${values.state} tasks` : "no tasks yet");
      else {
        const all = new Map(tasks.map((t) => [t.id, t]));
        const showLane = !lane && Object.keys(meta.lanes).length > 1;
        for (const t of shown) out(taskRow(t, all, showLane));
      }
      return 0;
    }
    case "task show": {
      const { values, positionals } = parse(rest, {}, 1);
      if (!positionals[0]) throw new UsageError("hcoord task show <id>");
      const { meta, task } = findTask(positionals[0]);
      if (values.json) {
        json({ project: meta.slug, ...task });
        return 0;
      }
      const all = new Map(loadTasks(meta.slug).tasks.map((t) => [t.id, t]));
      const deps = task.dependsOn.map((d) => `${d} (${all.get(d)?.state ?? "missing"})`).join(", ");
      const rows: [string, string | undefined][] = [
        ["project", meta.slug],
        ["worktree", task.lane],
        ["state", task.state],
        ["needs you", task.needsYouReason],
        ["summary", task.summary],
        ["depends on", deps || undefined],
        ["repo", task.repo],
        ["branch", task.branch],
        ["checkout", task.worktree],
        ["session", task.session],
        ["not merged", task.mergeError],
        ["terminal", task.terminal && `${task.terminal.name} (${task.terminal.address})`],
        ["created", task.createdAt],
        ["updated", task.updatedAt],
      ];
      out(`${task.id}  ${task.title}`);
      for (const [k, v] of rows) if (v) out(`${(k + ":").padEnd(12)}${v}`);
      out(`\nbrief:\n${task.brief.replace(/^/gm, "  ")}`);
      return 0;
    }
    default:
      if (group === "board") {
        const { values } = parse(cmd === undefined ? rest : [cmd, ...rest], {}, 0);
        const b = board();
        if (values.json) json(b);
        else if (!b.projects.length) out("no projects yet: hcoord project new <name> --repo <path>");
        else for (const p of b.projects) out(boardLine(p));
        return 0;
      }
      if (group === "log") {
        const { values, positionals } = parse(cmd === undefined ? rest : [cmd, ...rest], { lane: { type: "string" } }, 1);
        let log;
        if (values.lane) {
          const meta = loadProject(positionals[0] ?? defaultProjectSlug());
          const l = laneOf(meta, values.lane);
          log = renderLog({
            title: `${meta.name} · worktree ${values.lane}: coordinator`,
            session: l.coordinator?.session,
            promptLines: 3,
          });
        } else {
          if (!positionals[0]) throw new UsageError("hcoord log <task id> | --lane <key> [<slug>]");
          const { meta, task } = findTask(positionals[0]);
          const reports = existsSync(join(paths.reports(meta.slug), `${task.id}.md`))
            ? `---\n\n## Reports\n\n${readFileSync(join(paths.reports(meta.slug), `${task.id}.md`), "utf8").replace(/^## /gm, "### ")}`
            : "";
          log = renderLog({ title: `${task.id} ${task.title} (${task.state})`, session: task.session, extra: reports });
        }
        if (values.json) json(log);
        else out(log.markdown);
        return 0;
      }
      if (group === "mod" && cmd === "install") {
        parse(rest, {}, 0);
        return report_(installMod());
      }
      if (group === "recover") {
        const { positionals, values } = parse(cmd === undefined ? rest : [cmd, ...rest], { "no-show": { type: "boolean" } }, 1);
        const slugs = positionals[0] ? [loadProject(positionals[0]).slug] : listProjects().map((p) => p.slug);
        let ok = true;
        for (const slug of slugs) {
          const o = await recoverProject(slug, { show: !values["no-show"] });
          ok &&= o.ok;
          for (const l of o.lines) out(slugs.length > 1 ? `${slug}: ${l}` : l);
        }
        return ok ? 0 : 1;
      }
      if (group === "sync") {
        const { positionals } = parse(cmd === undefined ? rest : [cmd, ...rest], {}, 1);
        const slugs = positionals[0] ? [loadProject(positionals[0]).slug] : listProjects().map((p) => p.slug);
        let ok = true;
        for (const slug of slugs) {
          const o = await sync(slug);
          ok &&= o.ok;
          for (const l of o.lines) out(slugs.length > 1 ? `${slug}: ${l}` : l);
        }
        return ok ? 0 : 1;
      }
      if (group === "memory") {
        // hcoord memory [<slug>] <text...>: a first word naming a project is the slug.
        const words = cmd === undefined ? rest : [cmd, ...rest];
        const named = words.length > 1 && listProjects().some((p) => p.slug === words[0] || p.prefix === words[0]!.toUpperCase());
        const slug = named ? words[0]! : defaultProjectSlug();
        return report_(await addMemory(slug, (named ? words.slice(1) : words).join(" ")));
      }
      if (group === "worker-stopped") {
        // Called by a Claude worker's Stop hook. Never fails loudly: it must not disturb the worker.
        try {
          if (cmd) await workerStopped(cmd);
        } catch (e) {
          process.stderr.write(`hcoord worker-stopped: ${e instanceof Error ? e.message : e}\n`);
        }
        return 0;
      }
      if (group === "report") {
        const { values, positionals } = parse(
          cmd === undefined ? rest : [cmd, ...rest],
          { state: { type: "string" }, file: { type: "string" }, "no-notify": { type: "boolean" } },
          1,
        );
        if (!positionals[0]) throw new UsageError("hcoord report <id> --state done|needs_you|failed --file <file|->");
        if (!values.state || !REPORT_STATES.includes(values.state)) {
          throw new UsageError(`--state must be one of ${REPORT_STATES.join(", ")}`);
        }
        if (values.file === undefined) throw new UsageError("--file <report.md> (or - for stdin) is required");
        const text = await readFileArg(values.file);
        return report_(await report(positionals[0], values.state as ReportState, text, { notify: !values["no-notify"] }));
      }
      throw new UsageError(`unknown command: ${[group, cmd].filter(Boolean).join(" ")} (hcoord --help)`);
  }
}

function boardLine(p: BoardProject): string {
  const counts: Record<string, number> = {};
  for (const t of p.tasks) counts[t.state] = (counts[t.state] ?? 0) + 1;
  const summary = Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(", ") || "no tasks";
  return `${p.slug.padEnd(24)} ${summary}${p.trusted === false ? `  (Claude doesn't trust ${p.repo})` : ""}`;
}

function openOpts(values: Record<string, any>) {
  return { show: !values["no-show"], space: values.space, restart: values.restart, fresh: values.fresh };
}

/** Prints an outcome's lines; exit 1 if any part failed. */
function report_(o: Outcome): number {
  for (const l of o.lines) out(l);
  return o.ok ? 0 : 1;
}

async function readFileArg(file: string): Promise<string> {
  if (file === "-") return await Bun.stdin.text();
  try {
    return readFileSync(file, "utf8");
  } catch (e: any) {
    throw new HcoordError(`can't read ${file}: ${e.code ?? e.message}`);
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  if (e instanceof HcoordError) {
    process.stderr.write(`hcoord: ${e.message}\n`);
    process.exitCode = e.exitCode;
  } else {
    throw e;
  }
}
