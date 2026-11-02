import { appendFileSync } from "node:fs";
import { coordinatorArgv } from "./agents.ts";
import { loadConfig } from "./config.ts";
import { HcoordError } from "./errors.ts";
import { atomicWrite, withLock } from "./fsutil.ts";
import { hcGet, hcRunBg } from "./hc.ts";
import { paths, root } from "./paths.ts";
import { loadProject, type ProjectMeta } from "./store.ts";
import { liveCoordinator, trustWarnings, type Outcome } from "./workers.ts";

export const coordinatorName = (slug: string) => `coord-${slug}`.slice(0, 32);

/** Runs a herdr-app command; null result means the app isn't reachable. */
function app(args: string[]): any | null {
  try {
    const r = Bun.spawnSync(["herdr-app", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    if (r.exitCode !== 0) return null;
    const t = r.stdout.toString().trim();
    return t ? JSON.parse(t) : {};
  } catch {
    return null;
  }
}

/** The space to put the coordinator in: one whose folder is a project repo, else the shown one. */
function pickSpace(meta: ProjectMeta): string | null {
  const ls = app(["ls"]);
  if (!ls?.spaces) return null;
  const local = ls.spaces.filter((s: any) => !s.machine);
  const byRepo = local.find((s: any) => meta.repos.includes(s.folder));
  if (byRepo) return byRepo.id;
  const status = app(["status"]);
  return status?.space ?? local[0]?.id ?? null;
}

function tabOf(address: string): string | null {
  const ls = app(["ls"]);
  for (const s of ls?.spaces ?? []) {
    for (const t of s.tabs ?? []) if (t.terminals?.some((x: any) => x.terminal === address)) return t.id;
  }
  return null;
}

async function saveCoordinator(slug: string, coordinator: ProjectMeta["coordinator"]): Promise<void> {
  await withLock(paths.lock(slug), () => {
    const meta = loadProject(slug);
    if (coordinator) meta.coordinator = coordinator;
    else delete meta.coordinator;
    atomicWrite(paths.projectJson(slug), JSON.stringify(meta, null, 2) + "\n");
    appendFileSync(
      paths.eventsLog(slug),
      JSON.stringify({ ts: new Date().toISOString(), project: slug, type: "coordinator.set", data: coordinator ?? null }) + "\n",
    );
  });
}

/**
 * Starts the project's coordinator agent (or brings back the running one) in a Herdr tab
 * named "coord <slug>", in `opts.space` or the space whose folder is a project repo, else the
 * shown one. Without a Herdr window it runs headless; attach with `hc attach`.
 */
export async function openProject(project: string, opts: { show?: boolean; space?: string } = {}): Promise<Outcome> {
  const meta = loadProject(project);
  const slug = meta.slug;
  const name = coordinatorName(slug);
  const lines: string[] = [];

  const live = liveCoordinator(meta);
  if (live && loadConfig().agent.kind === "claude" && !hcGet(live.address)?.status) {
    // Claude reports a status as soon as it runs. A kept terminal recovered as a shell doesn't.
    return {
      ok: false,
      lines: [
        `${name} (${live.address}) is running but reports no agent status: Claude may have been replaced by a shell after a restart, or be at a prompt.`,
        `Look with: hc attach ${live.address}. To start a fresh coordinator: hc kill ${live.address}, then hcoord project open ${slug}`,
      ],
    };
  }
  if (live) {
    const shown = opts.show !== false && app(["do", "agent.focus", "--terminal", live.address]) !== null;
    lines.push(`coordinator ${name} (${live.address}) is already running${shown ? "; showing it" : ""}`);
    if (!shown) lines.push(`attach with: hc attach ${live.address}`);
    return { ok: true, lines };
  }
  if (hcGet(name)?.state === "live") {
    throw new HcoordError(`a terminal named ${name} is running but isn't this project's coordinator; stop it (hc kill ${name}) first`);
  }

  const space = opts.show === false ? null : (opts.space ?? pickSpace(meta));
  const tab = space ? `tbhcoord${slug.replace(/[^a-z0-9]/g, "")}${Date.now().toString(36)}` : null;
  const labels: Record<string, string> = { "hcoord.project": slug, "hcoord.role": "coordinator" };
  if (space && tab) Object.assign(labels, { "herdr.space": space, "herdr.tab": tab });

  // No parent: it must outlive whoever ran `project open`. Keep: a lost coordinator comes back as
  // a shell (never a rerun) and `project open` starts a fresh one.
  const argv = coordinatorArgv(loadConfig(), slug, name);
  const term = hcRunBg({ name, cwd: root(), argv, labels, parent: null, keep: true });
  await saveCoordinator(slug, term);
  lines.push(`started coordinator ${name} (${term.address}) in ${root()}`);

  if (space && tab) {
    // Herdr adopts labelled terminals within a moment; then name the tab and show it.
    let adopted = false;
    for (let i = 0; i < 40 && !adopted; i++) {
      adopted = tabOf(term.address) === tab;
      if (!adopted) await Bun.sleep(150);
    }
    if (adopted) {
      app(["do", "tab.rename", "--id", tab, "--name", `coord ${slug}`]);
      app(["do", "agent.focus", "--terminal", term.address]);
      lines.push(`showing it in the tab "coord ${slug}"`);
    } else {
      lines.push(`Herdr didn't show it yet; attach with: hc attach ${term.address}`);
    }
  } else {
    const why = opts.show === false ? "not shown in Herdr (--no-show)" : "no Herdr window found";
    lines.push(`${why}; attach with: hc attach ${term.address}`);
  }
  lines.push(`first run only: if Claude asks whether to trust ${root()}, choose "Yes, I trust this folder"`);
  lines.push(...trustWarnings(meta));
  return { ok: true, lines };
}

/** Appends a dated bullet to the project's MEMORY.md (the coordinator's notes to itself). */
export async function addMemory(project: string, text: string): Promise<Outcome> {
  const meta = loadProject(project);
  const note = text.replace(/\s+/g, " ").trim();
  if (!note) throw new HcoordError("nothing to remember", 2);
  await withLock(paths.lock(meta.slug), () => {
    appendFileSync(paths.memoryMd(meta.slug), `- ${new Date().toISOString().slice(0, 10)}: ${note}\n`);
  });
  return { ok: true, lines: [`noted in ${paths.memoryMd(meta.slug)}`] };
}
