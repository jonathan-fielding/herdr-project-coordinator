/** An agent's log: its Claude transcript (~/.claude/projects/<folder>/<session>.jsonl) as readable markdown. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where Claude keeps transcripts: $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects. */
export function transcriptsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || homedir(), ".claude");
  return join(base, "projects");
}

/** The transcript file of a session, in whichever project folder Claude put it; null if none yet. */
export function findTranscript(session: string, dir = transcriptsDir()): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(session) || !existsSync(dir)) return null;
  for (const d of readdirSync(dir)) {
    const f = join(dir, d, `${session}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

const MAX_LINES = 12;
const MAX_CHARS = 1500;

function clip(text: string, lines = MAX_LINES, chars = MAX_CHARS): string {
  let t = text.replace(/\s+$/, "");
  let cut = false;
  const ls = t.split("\n");
  if (ls.length > lines) {
    t = ls.slice(0, lines).join("\n");
    cut = true;
  }
  if (t.length > chars) {
    t = t.slice(0, chars);
    cut = true;
  }
  const hidden = ls.length - Math.min(ls.length, lines);
  return cut ? `${t}\n… (${hidden > 0 ? `${hidden} more lines` : "cut"})` : t;
}

/** A fence that the text can't close. */
function fenced(text: string, lang = ""): string {
  const ticks = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

const time = (ts?: string) => (ts ? ts.slice(11, 16) : "");

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b?.type === "text" ? b.text : b?.type === "image" ? "[image]" : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** One line saying what a tool call did. */
function describeCall(name: string, input: any): { head: string; body?: string; lang?: string } {
  const i = input ?? {};
  switch (name) {
    case "Bash":
      return { head: i.description ? `Ran: ${i.description}` : "Ran a command", body: i.command, lang: "sh" };
    case "Read":
      return { head: `Read \`${i.file_path}\`` };
    case "Write":
      return { head: `Wrote \`${i.file_path}\`${typeof i.content === "string" ? ` (${i.content.split("\n").length} lines)` : ""}` };
    case "Edit":
    case "MultiEdit":
      return { head: `Edited \`${i.file_path}\`` };
    case "NotebookEdit":
      return { head: `Edited notebook \`${i.notebook_path}\`` };
    case "Grep":
      return { head: `Searched for \`${i.pattern}\`${i.path ? ` in \`${i.path}\`` : ""}` };
    case "Glob":
      return { head: `Listed \`${i.pattern}\`` };
    case "TodoWrite":
      return {
        head: "Updated its to-do list",
        body: (i.todos ?? []).map((t: any) => `${t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]"} ${t.content}`).join("\n"),
      };
    case "WebFetch":
      return { head: `Fetched ${i.url}` };
    case "WebSearch":
      return { head: `Searched the web for “${i.query}”` };
    case "Skill":
      return { head: `Loaded skill ${i.skill ?? i.name ?? ""}` };
    default: {
      const json = JSON.stringify(i);
      return { head: `Used ${name}`, body: json.length > 2 ? clip(json, 6, 400) : undefined, lang: "json" };
    }
  }
}

export interface RenderOptions {
  /** Long first prompts (a worker's brief) are shortened to this many lines. */
  promptLines?: number;
}

/** A transcript (JSONL text) as markdown: what the agent said and did, with short results. */
export function renderTranscript(jsonl: string, opts: RenderOptions = {}): string {
  const entries: any[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A line still being written.
    }
  }
  const results = new Map<string, { text: string; error: boolean }>();
  for (const e of entries) {
    if (e.type !== "user" || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message.content) {
      if (b?.type === "tool_result") results.set(b.tool_use_id, { text: resultText(b.content), error: !!b.is_error });
    }
  }

  const out: string[] = [];
  let firstPrompt = true;
  for (const e of entries) {
    if (e.isSidechain) continue; // its own subagents' inner turns
    const at = time(e.timestamp);
    if (e.type === "user") {
      const c = e.message?.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n") : "";
      if (!text.trim() || e.isMeta) continue;
      // A slash command typed as the first message: show it as typed.
      const slash = text.match(/<command-name>([^<]+)<\/command-name>/);
      if (slash) {
        const args = text.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim() ?? "";
        out.push(`### ${firstPrompt ? "Task given" : "Prompt"}${at ? ` · ${at}` : ""}`, "", `> ${slash[1]!.trim()} ${args}`.trimEnd(), "");
        firstPrompt = false;
        continue;
      }
      if (/^<(command-|local-command|system-reminder)/.test(text.trim())) continue;
      const fromHc = text.trim().startsWith("<hc");
      const who = fromHc ? "Message from herdr-core" : firstPrompt ? "Task given" : "Prompt";
      const shown = firstPrompt && !fromHc ? clip(text.trim(), opts.promptLines ?? 8, 2000) : clip(text.trim(), 30, 3000);
      if (!fromHc) firstPrompt = false;
      out.push(`### ${who}${at ? ` · ${at}` : ""}`, "", shown.replace(/^/gm, "> "), "");
    } else if (e.type === "assistant") {
      for (const b of e.message?.content ?? []) {
        if (b?.type === "text" && b.text?.trim()) {
          out.push(`**Claude**${at ? ` · ${at}` : ""}`, "", b.text.trim(), "");
        } else if (b?.type === "tool_use") {
          const d = describeCall(b.name, b.input);
          const r = results.get(b.id);
          out.push(`- ${r?.error ? "✗ " : ""}${d.head}`);
          if (d.body) out.push("", fenced(clip(d.body, 15, 2000), d.lang).replace(/^/gm, "  "), "");
          if (r?.text.trim()) out.push("", fenced(clip(r.text)).replace(/^/gm, "  "), "");
        }
      }
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** The whole log of one agent: a title, its transcript, then anything else (reports). */
export function renderLog(opts: { title: string; session?: string; extra?: string; promptLines?: number }): {
  markdown: string;
  transcript: string | null;
} {
  const file = opts.session ? findTranscript(opts.session) : null;
  const parts = [`# ${opts.title}`, ""];
  if (!opts.session) parts.push("_No transcript: only Claude agents started by hcoord keep one._", "");
  else if (!file) parts.push(`_No transcript yet for session ${opts.session}._`, "");
  else parts.push(`<!-- ${file} -->`, "", renderTranscript(readFileSync(file, "utf8"), { promptLines: opts.promptLines }));
  if (opts.extra?.trim()) parts.push(opts.extra.trim(), "");
  return { markdown: parts.join("\n"), transcript: file };
}
