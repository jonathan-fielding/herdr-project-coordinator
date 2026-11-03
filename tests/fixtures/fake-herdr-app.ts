// A stand-in for the Herdr window's CLI (herdr-app): logs each call to $FAKE_HERDR_LOG (one JSON argv per
// line) and answers `status` and `ls` from the terminals in the test's herdr-core, the way Herdr adopts
// them: a terminal labelled herdr.space/herdr.tab shows in that space and tab.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_HERDR_LOG!, JSON.stringify(args) + "\n");
if (args[0] === "status") console.log(JSON.stringify({ space: "spopened" }));
else if (args[0] === "ls") {
  const r = Bun.spawnSync(["hc", "ls", "--json"], { stdout: "pipe", stderr: "pipe" });
  const listed = (JSON.parse(r.stdout.toString() || "{}").terminals ?? []) as any[];
  // `hc ls` leaves labels out: each terminal's own record has them.
  const terms = listed.map((t) => JSON.parse(Bun.spawnSync(["hc", "get", t.address, "--json"], { stdout: "pipe" }).stdout.toString() || "{}"));
  const spaces = new Map<string, Map<string, string[]>>([["spopened", new Map()]]);
  for (const t of terms) {
    const s = t.labels?.["herdr.space"];
    const tab = t.labels?.["herdr.tab"];
    if (!s || !tab) continue;
    if (!spaces.has(s)) spaces.set(s, new Map());
    const tabs = spaces.get(s)!;
    tabs.set(tab, [...(tabs.get(tab) ?? []), t.address]);
  }
  console.log(JSON.stringify({
    spaces: [...spaces].map(([id, tabs]) => ({
      id, folder: "/", machine: null,
      tabs: [...tabs].map(([tid, ts]) => ({ id: tid, terminals: ts.map((terminal) => ({ terminal })) })),
    })),
  }));
} else console.log(JSON.stringify({ ok: true }));
