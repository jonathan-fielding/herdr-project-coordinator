import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, readJson } from "./fsutil.ts";
import { paths, root } from "./paths.ts";
import { HcoordError } from "./errors.ts";

export type AgentKind = "claude" | "codex";

export interface Config {
  version: 1;
  agent: {
    kind: AgentKind;
    /** argv used to start a worker or coordinator; the prompt is appended as the last argument. */
    command: string[];
  };
  /** Worktrees go to <worktreeRoot>/<project>/<task id>. */
  worktreeRoot: string;
  /** Workers running at once per project; more tasks wait as `queued`. */
  maxParallel: number;
}

export function defaultConfig(): Config {
  return {
    version: 1,
    agent: { kind: "claude", command: ["claude"] },
    worktreeRoot: join(root(), "worktrees"),
    maxParallel: 3,
  };
}

/** Reads config.json over the defaults (missing keys take the default). */
export function loadConfig(): Config {
  const d = defaultConfig();
  if (!existsSync(paths.config())) return d;
  const c = readJson<Partial<Config>>(paths.config());
  const merged: Config = { ...d, ...c, agent: { ...d.agent, ...(c.agent ?? {}) } };
  if (!Number.isInteger(merged.maxParallel) || merged.maxParallel < 1) {
    throw new HcoordError(`config.json: maxParallel must be a whole number ≥ 1 (got ${merged.maxParallel})`);
  }
  if (!Array.isArray(merged.agent.command) || merged.agent.command.length === 0) {
    throw new HcoordError("config.json: agent.command must be a non-empty array");
  }
  return merged;
}

/** Creates the data root and a default config.json if they don't exist. */
export function ensureRoot(): void {
  mkdirSync(paths.projects(), { recursive: true });
  if (!existsSync(paths.config())) {
    atomicWrite(paths.config(), JSON.stringify(defaultConfig(), null, 2) + "\n");
  }
}
