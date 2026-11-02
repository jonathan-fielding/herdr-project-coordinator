#!/usr/bin/env bun
import { readFileSync } from "node:fs";
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

const HELP = `hcoord ${pkg.version}: tasks and workers for a Herdr coordinator

Projects
  hcoord project new <name> --repo <path> [--repo <path>...] [--prefix ABC]
  hcoord project list [--json]
  hcoord project show [<slug>] [--json]

Tasks
  hcoord task add [<slug>] --title <text> (--brief-file <file|-> | --brief <text>)
                  [--depends-on ID[,ID...]]... [--repo <path>] [--json]
  hcoord task list [<slug>] [--state <state>] [--json]
  hcoord task show <id> [--json]

<slug> may be left out when $HCOORD_PROJECT is set or only one project exists.
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

function taskRow(t: Task, all: Map<string, Task>): string {
  const waits = t.dependsOn.filter((d) => all.get(d)?.state !== "done");
  return `${t.id.padEnd(9)} ${t.state.padEnd(10)} ${t.title}${waits.length ? `  (after ${waits.join(", ")})` : ""}`;
}

async function readBrief(values: Record<string, any>): Promise<string> {
  if (values.brief !== undefined && values["brief-file"] !== undefined) {
    throw new UsageError("use --brief or --brief-file, not both");
  }
  if (values.brief !== undefined) return values.brief;
  const file = values["brief-file"];
  if (file === undefined) throw new UsageError("--brief-file <file> (or - for stdin) or --brief <text> is required");
  if (file === "-") return await Bun.stdin.text();
  try {
    return readFileSync(file, "utf8");
  } catch (e: any) {
    throw new HcoordError(`can't read brief file ${file}: ${e.code ?? e.message}`);
  }
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
      const { values, positionals } = parse(
        rest,
        { repo: { type: "string", multiple: true }, prefix: { type: "string" } },
        1,
      );
      if (!positionals[0]) throw new UsageError("hcoord project new <name> --repo <path>");
      const meta = await createProject({ name: positionals[0], repos: values.repo ?? [], prefix: values.prefix });
      if (values.json) json(meta);
      else out(`created ${meta.slug} (tasks ${meta.prefix}-n) at ${paths.project(meta.slug)}\nedit ${paths.projectMd(meta.slug)} to add standing instructions`);
      return 0;
    }
    case "project list": {
      const { values } = parse(rest, {}, 0);
      const all = listProjects();
      if (values.json) json(all);
      else if (!all.length) out("no projects yet: hcoord project new <name> --repo <path>");
      else for (const p of all) out(`${p.slug.padEnd(24)} ${p.prefix.padEnd(6)} ${p.repos.join(", ")}`);
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
        out(`repos:   ${meta.repos.join(", ")}`);
        out(`tasks:   ${tasks.length ? Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(", ") : "none"}`);
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
          repo: { type: "string" },
        },
        1,
      );
      if (values.title === undefined) throw new UsageError("--title is required");
      const slug = positionals[0] ?? defaultProjectSlug();
      const brief = await readBrief(values);
      const dependsOn = ((values["depends-on"] as string[] | undefined) ?? []).flatMap((d) => d.split(/[,\s]+/));
      const task = await addTask(slug, { title: values.title, brief, dependsOn, repo: values.repo });
      if (values.json) json(task);
      else out(task.id);
      return 0;
    }
    case "task list": {
      const { values, positionals } = parse(rest, { state: { type: "string" } }, 1);
      if (values.state !== undefined && !isTaskState(values.state)) throw new UsageError(`unknown state: ${values.state}`);
      const slug = loadProject(positionals[0] ?? defaultProjectSlug()).slug;
      const tasks = loadTasks(slug).tasks.sort(byNumber);
      const shown = values.state ? tasks.filter((t) => t.state === values.state) : tasks;
      if (values.json) json(shown);
      else if (!shown.length) out(values.state ? `no ${values.state} tasks` : "no tasks yet");
      else {
        const all = new Map(tasks.map((t) => [t.id, t]));
        for (const t of shown) out(taskRow(t, all));
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
        ["state", task.state],
        ["needs you", task.needsYouReason],
        ["summary", task.summary],
        ["depends on", deps || undefined],
        ["repo", task.repo],
        ["branch", task.branch],
        ["worktree", task.worktree],
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
      throw new UsageError(`unknown command: ${[group, cmd].filter(Boolean).join(" ")} (hcoord --help)`);
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
