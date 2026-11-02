import { HcoordError } from "./errors.ts";

/** The hc binary ($HCOORD_HC overrides, for tests). */
const HC = () => process.env.HCOORD_HC || "hc";

export interface HcTerminal {
  address: string;
  name?: string | null;
  state: "live" | "finished";
  /** Agent status word (working, blocked, idle, done, error) or absent for plain programs. */
  status?: string | null;
  parent?: string | null;
  exit_code?: number | null;
  reason?: string | null;
  signal?: number | null;
  /** Turns the agent has taken (agents only). */
  turn?: number;
  /** Present on `hc get`, not on `hc ls`. */
  labels?: Record<string, string>;
}

interface HcResult {
  ok: boolean;
  data: any;
  error?: string;
}

/** Runs `hc <args> --json` and parses its output. Never throws for hc-level errors. */
export function hcCall(args: string[]): HcResult {
  // --json must come before "--": after it, it would be the started program's own argument.
  const dd = args.indexOf("--");
  const full = dd < 0 ? [...args, "--json"] : [...args.slice(0, dd), "--json", ...args.slice(dd)];
  let r;
  try {
    r = Bun.spawnSync([HC(), ...full], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  } catch (e: any) {
    return { ok: false, data: null, error: `can't run ${HC()}: ${e.message}` };
  }
  const stdout = r.stdout.toString().trim();
  const stderr = r.stderr.toString().trim();
  if (r.exitCode !== 0) {
    let msg = stderr || stdout || `exit ${r.exitCode}`;
    try {
      const e = JSON.parse(stderr || stdout).error;
      if (e?.message) msg = e.message + (e.hint ? ` (${e.hint})` : "");
    } catch {}
    return { ok: false, data: null, error: msg };
  }
  try {
    return { ok: true, data: stdout ? JSON.parse(stdout) : null };
  } catch {
    return { ok: true, data: stdout };
  }
}

function must(args: string[], what: string): any {
  const r = hcCall(args);
  if (!r.ok) throw new HcoordError(`${what}: ${r.error}`);
  return r.data;
}

export interface RunOptions {
  name: string;
  cwd: string;
  argv: string[];
  /** Coordinator address; null = no parent (and no notes to anyone). */
  parent: string | null;
  labels: Record<string, string>;
  /** Core keep: a lost program is replaced by a shell (never rerun). */
  keep?: boolean;
}

/** Starts a background terminal that outlives its parent. Returns its address. */
export function hcRunBg(o: RunOptions): { address: string; name: string } {
  const args = ["run", "--bg", "--outlive-parent", "--name", o.name, "--cwd", o.cwd];
  if (o.keep) args.push("--keep");
  args.push(...(o.parent ? ["--parent", o.parent] : ["--no-parent"]));
  for (const [k, v] of Object.entries(o.labels)) args.push("--label", `${k}=${v}`);
  args.push("--", ...o.argv);
  const d = must(args, `starting ${o.name}`);
  if (!d?.address) throw new HcoordError(`starting ${o.name}: hc gave no address (${JSON.stringify(d)})`);
  return { address: d.address, name: d.name ?? o.name };
}

/** Every terminal (live and finished) carrying all these labels. Throws if the core can't be reached. */
export function hcList(labels: Record<string, string>): HcTerminal[] {
  const args = ["ls", "--all"];
  for (const [k, v] of Object.entries(labels)) args.push("--label", `${k}=${v}`);
  return (must(args, "listing terminals")?.terminals ?? []) as HcTerminal[];
}

/** One terminal, or null if the core doesn't know it. */
export function hcGet(t: string): HcTerminal | null {
  const r = hcCall(["get", t]);
  return r.ok ? (r.data as HcTerminal) : null;
}

export function hcKill(t: string): HcResult {
  return hcCall(["kill", t]);
}

export function hcRm(t: string): HcResult {
  return hcCall(["rm", t]);
}

export function hcSend(t: string, text: string): HcResult {
  return hcCall(["send", t, text]);
}
