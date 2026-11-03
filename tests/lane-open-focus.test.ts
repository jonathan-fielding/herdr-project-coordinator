/** `hcoord lane open --new-space`: what it asks of the Herdr window, and in what order (HCM-9). */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestCore } from "./hccore.ts";
import { cli, tempDir, tempRepo } from "./helpers.ts";

const core = new TestCore();
beforeAll(() => core.start());
afterAll(() => core.stop());

let home: string, repo: string, bin: string, log: string;
afterEach(() => {
  for (const t of core.hc("ls", "--label", "hcoord.project=demo").terminals ?? []) core.hc("kill", t.address);
  for (const d of [home, repo, bin]) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

async function setup() {
  home = tempDir("home");
  repo = tempRepo("app");
  bin = tempDir("bin");
  log = join(bin, "calls.log");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-qm", "init");
  writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, agent: { kind: "generic", command: ["sh", "-c", "sleep 300"] }, worktreeRoot: join(home, "wt") }));
  const fake = join(bin, "herdr-app");
  writeFileSync(fake, `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, "fixtures", "fake-herdr-app.ts")}' "$@"\n`);
  chmodSync(fake, 0o755);
  const env = { ...core.env, PATH: `${bin}:${core.env.PATH}`, FAKE_HERDR_LOG: log };
  const hcoord = (...args: string[]) => cli(home, args, undefined, env);
  const r = await hcoord("project", "new", "demo", "--repo", repo, "--prefix", "DM");
  if (r.code !== 0) throw new Error(r.stdout + r.stderr);
  return hcoord;
}
const calls = (): string[][] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const doing = () => calls().filter((c) => c[0] === "do").map((c) => c[1]);

describe("lane open --new-space", () => {
  test("names the new space and tab, then selects it and focuses the coordinator, never the space it was opened from", async () => {
    const hcoord = await setup();
    const r = await hcoord("lane", "open", repo, "--new-space", "demo · main");
    expect(r.code).toBe(0);
    expect(doing()).toEqual(["space.rename", "tab.rename", "space.select", "agent.focus"]);
    const select = calls().find((c) => c[1] === "space.select")!;
    expect(select[3]).toMatch(/^sp[0-9a-f]{32}$/);
    expect(select[3]).not.toBe("spopened");
  }, 30_000);

  test("--no-focus: shown and named, but nothing selected or focused; --json gives the terminal to focus", async () => {
    const hcoord = await setup();
    const r = await hcoord("lane", "open", repo, "--new-space", "demo · main", "--no-focus", "--json");
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ project: "demo", lane: "root", ok: true });
    expect(out.terminal).toMatch(/^t/);
    expect(doing()).toEqual(["space.rename", "tab.rename"]);

    // Opened again while it runs: still no focus, the same terminal.
    const again = JSON.parse((await hcoord("lane", "open", repo, "--no-focus", "--json")).stdout);
    expect(again.terminal).toBe(out.terminal);
    expect(doing()).toEqual(["space.rename", "tab.rename"]);
  }, 30_000);
});
