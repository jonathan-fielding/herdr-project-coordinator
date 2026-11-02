import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CLI = join(import.meta.dir, "..", "src", "cli.ts");

/** A fresh temp folder (realpath'd: macOS tmp is a symlink). */
export function tempDir(label: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `hcoord-${label}-`)));
}

/** A throwaway git repo (no commits needed for rev-parse --show-toplevel). */
export function tempRepo(label = "repo"): string {
  const dir = tempDir(label);
  const r = Bun.spawnSync(["git", "init", "-q", dir]);
  if (r.exitCode !== 0) throw new Error(`git init failed: ${r.stderr}`);
  mkdirSync(join(dir, "src"), { recursive: true });
  return dir;
}

/** Points the store at a new temp root for this test; returns it and a cleanup. */
export function useTempHome(): { home: string; cleanup: () => void } {
  const home = tempDir("home");
  const prev = process.env.HCOORD_HOME;
  const prevProject = process.env.HCOORD_PROJECT;
  process.env.HCOORD_HOME = home;
  delete process.env.HCOORD_PROJECT;
  return {
    home,
    cleanup: () => {
      if (prev === undefined) delete process.env.HCOORD_HOME;
      else process.env.HCOORD_HOME = prev;
      if (prevProject !== undefined) process.env.HCOORD_PROJECT = prevProject;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs hcoord. `baseEnv` (e.g. a TestCore's) replaces process.env, so hc talks to that core. */
export async function cli(
  home: string,
  args: string[],
  stdin?: string,
  baseEnv: Record<string, string | undefined> = process.env,
): Promise<CliResult> {
  const env: Record<string, string | undefined> = { ...baseEnv, HCOORD_HOME: home };
  delete env.HCOORD_PROJECT;
  const p = Bun.spawn(["bun", CLI, ...args], {
    env,
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, stdout, stderr };
}
