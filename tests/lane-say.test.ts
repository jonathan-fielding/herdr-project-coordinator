/** hcoord lane say: text for a worktree's coordinator, which is started first if it isn't running. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestCore } from "./hccore.ts";
import { cli, tempDir, tempRepo } from "./helpers.ts";

const core = new TestCore();
beforeAll(() => core.start());
afterAll(() => core.stop());

let home: string;
let repo: string;

/** The stand-in coordinator appends whatever is typed into it to <home>/inbox.txt. */
function setup() {
  home = tempDir("home");
  repo = tempRepo("app");
  const coordinatorCmd = ["sh", "-c", `cat >> '${join(home, "inbox.txt")}'`];
  writeFileSync(join(home, "config.json"), JSON.stringify({
    version: 1,
    agent: { kind: "generic", command: coordinatorCmd, coordinatorArgs: [] },
    worktreeRoot: join(home, "wt"),
  }));
}

afterEach(() => {
  for (const t of core.hc("ls", "--label", "hcoord.project=demo").terminals ?? []) core.hc("kill", t.address);
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

const hcoord = (...args: string[]) => cli(home, args, undefined, core.env);
const ok = async (...args: string[]) => {
  const r = await hcoord(...args);
  if (r.code !== 0) throw new Error(`hcoord ${args.join(" ")} → ${r.code}:\n${r.stdout}${r.stderr}`);
  return r.stdout;
};
const meta = () => JSON.parse(readFileSync(join(home, "projects", "demo", "project.json"), "utf8"));
const inbox = () => (existsSync(join(home, "inbox.txt")) ? readFileSync(join(home, "inbox.txt"), "utf8") : "");

async function until(what: string, pred: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

describe("lane say", () => {
  test("starts the coordinator when it isn't running, then types the text into it", async () => {
    setup();
    await ok("project", "new", "demo", "--repo", repo, "--prefix", "DM");
    const out = await ok("lane", "say", repo, "Raise a PR for this worktree's branch (x) against main.", "--no-show");
    expect(out).toContain("started coordinator coord-dm-root");
    expect(out).toContain("sent to coord-dm-root");
    await until("the text to arrive", () => inbox().includes("Raise a PR for this worktree's branch (x) against main."));

    // Running already: the same terminal gets it, nothing new is started.
    const first = meta().lanes.root.coordinator.address;
    const again = await cli(home, ["lane", "say", repo, "--file", "-", "--no-show"], "And a second thing.\n", core.env);
    expect(again.code).toBe(0);
    expect(again.stdout).not.toContain("started");
    await until("the second text", () => inbox().includes("And a second thing."));
    expect(meta().lanes.root.coordinator.address).toBe(first);
  });

  test("refuses empty text and a missing path", async () => {
    setup();
    await ok("project", "new", "demo", "--repo", repo, "--prefix", "DM");
    expect((await hcoord("lane", "say")).code).toBe(2);
    const empty = await hcoord("lane", "say", repo, "  ");
    expect(empty.code).toBe(2);
    expect(empty.stderr).toContain("empty");
  });
});
