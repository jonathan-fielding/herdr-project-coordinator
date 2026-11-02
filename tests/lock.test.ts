import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, withLock } from "../src/fsutil.ts";
import { cli, tempDir, tempRepo } from "./helpers.ts";

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dir = (label: string) => {
  const d = tempDir(label);
  cleanups.push(d);
  return d;
};

describe("withLock", () => {
  test("serialises overlapping critical sections in one process", async () => {
    const lock = join(dir("lock"), ".lock");
    let inside = 0;
    let maxInside = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        withLock(lock, async () => {
          inside++;
          maxInside = Math.max(maxInside, inside);
          await Bun.sleep(5);
          order.push(i);
          inside--;
        }),
      ),
    );
    expect(maxInside).toBe(1);
    expect(order.sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(existsSync(lock)).toBe(false);
  });

  test("releases the lock when fn throws", async () => {
    const lock = join(dir("lock"), ".lock");
    await expect(withLock(lock, () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(existsSync(lock)).toBe(false);
  });

  test("takes over a lock left by a dead process", async () => {
    const lock = join(dir("lock"), ".lock");
    // Spawn and reap a process so its pid is (almost certainly) not alive.
    const p = Bun.spawnSync(["true"]);
    writeFileSync(lock, `${p.pid} ${Date.now()} deadbeef`);
    const got = await withLock(lock, () => "ok", { timeoutMs: 1_000 });
    expect(got).toBe("ok");
  });

  test("times out on a fresh lock held by a live process", async () => {
    const lock = join(dir("lock"), ".lock");
    writeFileSync(lock, `${process.pid} ${Date.now()} other`);
    await expect(withLock(lock, () => "never", { timeoutMs: 150 })).rejects.toThrow(/timed out after 150 ms/);
    expect(readFileSync(lock, "utf8")).toContain("other");
  });

  test("takes over a live holder's lock once it is older than staleMs", async () => {
    const lock = join(dir("lock"), ".lock");
    writeFileSync(lock, `${process.pid} ${Date.now() - 10_000} hung`);
    expect(await withLock(lock, () => "ok", { timeoutMs: 500, staleMs: 1_000 })).toBe("ok");
  });
});

describe("atomicWrite", () => {
  test("replaces the file and leaves no temp files", () => {
    const d = dir("atomic");
    const f = join(d, "x.json");
    atomicWrite(f, "one");
    atomicWrite(f, "two");
    expect(readFileSync(f, "utf8")).toBe("two");
    expect(readdirSync(d)).toEqual(["x.json"]);
  });
});

describe("concurrent writers (separate processes)", () => {
  test("20 parallel `task add` calls all land, with unique ids and one event each", async () => {
    const home = dir("home");
    const repo = tempRepo();
    cleanups.push(repo);
    expect((await cli(home, ["project", "new", "Race", "--repo", repo, "--prefix", "RC"])).code).toBe(0);

    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => cli(home, ["task", "add", "race", "--title", `job ${i}`, "--brief", `do ${i}`])),
    );
    for (const r of results) expect(r).toMatchObject({ code: 0, stderr: "" });

    const ids = results.map((r) => r.stdout.trim()).sort();
    expect(new Set(ids).size).toBe(N);
    expect(ids).toEqual(Array.from({ length: N }, (_, i) => `RC-${i + 1}`).sort());

    const projDir = join(home, "projects", "race");
    const file = JSON.parse(readFileSync(join(projDir, "tasks.json"), "utf8"));
    expect(file.nextId).toBe(N + 1);
    expect(file.tasks).toHaveLength(N);
    expect(new Set(file.tasks.map((t: any) => t.title)).size).toBe(N);

    const events = readFileSync(join(projDir, "events.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(events.filter((e) => e.type === "task.created")).toHaveLength(N);
    expect(events[0].type).toBe("project.created");

    const md = readFileSync(join(projDir, "TASKS.md"), "utf8");
    expect(md).toContain(`## To do (${N})`);
    expect(readdirSync(projDir).filter((f) => f.includes(".tmp-") || f === ".lock")).toEqual([]);
  }, 30_000);
});
