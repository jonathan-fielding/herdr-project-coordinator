/** Copies the Projects section mod into Herdr's mods folder. */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { HcoordError } from "./errors.ts";
import { root, rootWarning } from "./paths.ts";
import type { Outcome } from "./workers.ts";

export const MOD_NAME = "hcoord";
export const MOD_SOURCE = resolve(import.meta.dir, "..", "mod", MOD_NAME);
const CLI = resolve(import.meta.dir, "cli.ts");
/** Marks a mod folder as hcoord's, so install never replaces someone else's. Hidden: Herdr ignores it. */
const MARKER = ".hcoord-installed";

export function herdrAppHome(): string {
  return process.env.HERDR_APP_HOME || join(process.env.HOME || homedir(), ".config", "herdr-app");
}

export function modDir(): string {
  return join(herdrAppHome(), "mods", MOD_NAME);
}

/** The mod runs hcoord with this exact bun and cli.ts, so it never depends on the app's PATH. */
export function pathModule(): string {
  // exec() takes no environment, so a non-default data root goes through env(1).
  const argv = process.env.HCOORD_HOME
    ? ["/usr/bin/env", `HCOORD_HOME=${process.env.HCOORD_HOME}`, Bun.which("bun") ?? process.execPath, CLI]
    : [Bun.which("bun") ?? process.execPath, CLI];
  return `// Written by \`hcoord mod install\`: how this mod runs hcoord.\nexport const HCOORD = ${JSON.stringify(argv)};\n`;
}

export function installMod(opts: { temp?: boolean } = {}): Outcome {
  const dest = modDir();
  // The mod would keep using that folder long after it's gone (that happened once already).
  if (rootWarning() && !opts.temp) {
    throw new HcoordError(`not installing the mod for ${root()}: it's a temporary folder the system may empty. Install it without HCOORD_HOME, or pass --temp for a throwaway test`);
  }
  if (!existsSync(join(herdrAppHome(), "mods"))) {
    throw new HcoordError(`no Herdr mods folder at ${join(herdrAppHome(), "mods")}: is the Herdr app installed? ($HERDR_APP_HOME overrides)`);
  }
  if (existsSync(dest) && !existsSync(join(dest, MARKER))) {
    throw new HcoordError(`${dest} exists and wasn't installed by hcoord; move it away first`);
  }
  mkdirSync(dest, { recursive: true });
  const files = readdirSync(MOD_SOURCE).filter((f) => !f.startsWith(".") && f !== "hcoord-path.js");
  // Code last: Herdr reloads on every save, and main.js imports hcoord-path.js.
  writeFileSync(join(dest, MARKER), `${MOD_SOURCE}\n`);
  writeFileSync(join(dest, "hcoord-path.js"), pathModule());
  for (const f of files.filter((f) => f !== "main.js")) cpSync(join(MOD_SOURCE, f), join(dest, f), { recursive: true });
  cpSync(join(MOD_SOURCE, "main.js"), join(dest, "main.js"));
  return {
    ok: true,
    lines: [
      `installed the Projects section to ${dest}`,
      `check it: herdr-app check ${dest}`,
      `show it: add { "id": "projects", "type": "block", "content": { "mod": "${MOD_NAME}" } } to a layout you own`,
    ],
  };
}

/** Whether the installed copy matches this repo's (for doctor). */
export function modInstalledCurrent(): boolean | null {
  const dest = modDir();
  if (!existsSync(join(dest, "main.js"))) return null;
  return readFileSync(join(dest, "main.js"), "utf8") === readFileSync(join(MOD_SOURCE, "main.js"), "utf8");
}
