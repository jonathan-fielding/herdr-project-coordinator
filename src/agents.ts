import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Config } from "./config.ts";
import { HcoordError } from "./errors.ts";

/** This repo's Claude Code plugin (the coordinator skill), loaded per session with --plugin-dir. */
export const PLUGIN_DIR = resolve(import.meta.dir, "..", "plugin");
const CLI = resolve(import.meta.dir, "cli.ts");

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * `env` prefix for every agent we start: the project, our data root when it isn't the default,
 * and no CLAUDE_CODE_CHILD_SESSION (inherited from a Claude parent, it turns off transcript saving).
 */
function envPrefix(slug: string, lane?: string): string[] {
  const e = ["env", "-u", "CLAUDE_CODE_CHILD_SESSION", `HCOORD_PROJECT=${slug}`];
  if (lane) e.push(`HCOORD_LANE=${lane}`);
  if (process.env.HCOORD_HOME) e.push(`HCOORD_HOME=${process.env.HCOORD_HOME}`);
  return e;
}

function supported(config: Config): void {
  if (config.agent.kind === "codex") {
    throw new HcoordError('agent kind "codex" isn\'t supported yet (planned: it needs --no-daemon and its own report hook)');
  }
}

/** argv for a worker. The prompt goes last; Claude's variadic --allowedTools is never right before it. */
export function workerArgv(
  config: Config, slug: string, taskId: string, name: string, prompt: string, session?: string,
): string[] {
  supported(config);
  const a = config.agent;
  if (a.kind !== "claude") return [...envPrefix(slug), ...a.command, ...(a.workerArgs ?? []), prompt];
  // Stop fires at the end of every turn; hcoord ignores it unless the task is still "working" (no report).
  const stopHook = `${shq(process.execPath)} ${shq(CLI)} worker-stopped ${taskId}`;
  const settings = { hooks: { Stop: [{ hooks: [{ type: "command", command: stopHook, timeout: 15 }] }] } };
  return [
    ...envPrefix(slug),
    ...a.command,
    "--allowedTools",
    "Bash(hcoord report *)",
    "--settings",
    JSON.stringify(settings),
    "--name",
    name,
    // Its own session id: the transcript hcoord log shows.
    ...(session ? ["--session-id", session] : []),
    ...(a.workerArgs ?? []),
    prompt,
  ];
}

/**
 * argv for a worktree's coordinator. `session`: a new session with that id, or with `resume` the
 * earlier one, carried on (after a reboot).
 */
export function coordinatorArgv(
  config: Config, slug: string, lane: string, name: string, session?: string, resume = false,
): string[] {
  supported(config);
  const a = config.agent;
  if (a.kind !== "claude") {
    return [...envPrefix(slug, lane), ...a.command, ...(a.coordinatorArgs ?? []), `You coordinate hcoord project ${slug}, worktree ${lane}.`];
  }
  const sessionArgs = session ? (resume ? ["--resume", session] : ["--session-id", session]) : [];
  const prompt = resume
    ? `You were restarted (after a reboot or a crash) and are still coordinating hcoord project ${slug}, worktree ${lane}. Run \`hcoord task list\` and carry on from where things are.`
    : `/hcoord:coordinator ${slug} ${lane}`;
  return [
    ...envPrefix(slug, lane),
    ...a.command,
    "--allowedTools",
    "Bash(hcoord *)",
    "Bash(hc *)",
    "--plugin-dir",
    PLUGIN_DIR,
    "--name",
    name,
    ...sessionArgs,
    ...(a.coordinatorArgs ?? []),
    prompt,
  ];
}

/**
 * Whether Claude Code trusts the git repo at `repoRoot` (read-only look at ~/.claude.json).
 * Observed with Claude Code 2.1.316: trust belongs to the git root, and a worktree takes its main
 * repo's trust, so workers never prompt in a trusted repo. A repo nested in a trusted folder is
 * NOT trusted. Untrusted, a new session stops at the "trust this folder?" dialog, which reports no
 * status, so a worker would wait silently.
 * Returns true (the repo itself is trusted), false (nothing on its path is), or null (can't tell:
 * no file, or only a parent folder is trusted).
 */
export function claudeTrusts(
  repoRoot: string,
  file = process.env.HCOORD_CLAUDE_JSON || join(homedir(), ".claude.json"),
): boolean | null {
  if (!existsSync(file)) return null;
  let projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
  try {
    projects = JSON.parse(readFileSync(file, "utf8")).projects ?? {};
  } catch {
    return null;
  }
  const root = resolve(repoRoot);
  if (projects[root]?.hasTrustDialogAccepted) return true;
  for (let d = dirname(root); ; d = dirname(d)) {
    if (projects[d]?.hasTrustDialogAccepted) return null;
    if (dirname(d) === d) return false;
  }
}

export function untrustedRepoMessage(repo: string): string {
  return (
    `Claude Code hasn't been told to trust ${repo}, so a worker would stop at its "trust this folder?" prompt. ` +
    `Run \`claude\` in ${repo} once and choose "Yes, I trust this folder", then start the task again.`
  );
}

/** True when a terminal's screen shows Claude's folder-trust dialog. */
export function showsTrustPrompt(screen: string): boolean {
  return /trust this folder/i.test(screen);
}
