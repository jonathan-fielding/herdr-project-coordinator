import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A private herdr-core for tests (its own HC_SESSION and XDG folders), so tests never touch the
 * person's real core or show up in the Herdr window. Paths stay short: macOS sockets allow 103 bytes.
 */
export class TestCore {
  readonly dir = realpathSync(mkdtempSync(join(tmpdir(), "hct.")));
  readonly env: Record<string, string | undefined>;

  constructor() {
    const env: Record<string, string | undefined> = {
      ...process.env,
      HC_SESSION: "t",
      XDG_STATE_HOME: join(this.dir, "s"),
      XDG_CONFIG_HOME: join(this.dir, "c"),
      XDG_RUNTIME_DIR: join(this.dir, "r"),
    };
    // Inherited from the terminal running the tests: they would point hc at the real core.
    for (const k of ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SCOPE", "HC_SOCKET", "HCOORD_PROJECT"]) delete env[k];
    this.env = env;
  }

  hc(...args: string[]): any {
    // --json goes before "--", or it would become the program's own argument.
    const dd = args.indexOf("--");
    const full = dd < 0 ? [...args, "--json"] : [...args.slice(0, dd), "--json", ...args.slice(dd)];
    const r = Bun.spawnSync(["hc", ...full], { env: this.env, stdout: "pipe", stderr: "pipe" });
    const text = r.stdout.toString().trim();
    if (r.exitCode !== 0) throw new Error(`hc ${args.join(" ")}: ${r.stderr.toString().trim() || text}`);
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text;
    }
  }

  start(): void {
    this.hc("server", "start");
  }

  stop(): void {
    try {
      this.hc("server", "stop");
    } catch {}
    rmSync(this.dir, { recursive: true, force: true });
  }
}
