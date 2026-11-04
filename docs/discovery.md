# Phase 0: Discovery

Date: 2026-11-02. Machine: `macbook-pro` (macOS, Apple Silicon). Everything below was checked live on this machine unless marked **unverified**.

## 1. Installed versions

| Tool | Version | Path |
|---|---|---|
| herdr-core (`hc`) | 0.1.17 (core uptime ~23 min, `installed_by: null`) | `~/.local/bin/hc` |
| herdr-app | 0.1.12 | `~/.local/bin/herdr-app` |
| Claude Code | 2.1.316 | `~/.local/bin/claude` → `~/.local/share/claude/versions/2.1.316` |
| git | system | `/usr/bin/git` |
| **Bun** | **not installed** | none (node v24.18.0 via Volta and Homebrew are available) |

- `docs/hc-schema.json` is `hc schema --json`. It is **OpenRPC 1.3.2** (keys `openrpc`, `info`, `methods`, `components`) with 32 methods: `hello`, `server.*`, `terminal.{run,list,get,kill,rm,keep,label,read,attach,send,wait,keys,interrupt,put}`, `templates.list`, `machine.*`, `file.{read,write,edit}`, `doc.{get,set}`, `events.subscribe`, `rpc.discover`. (`hc schema --help` calls it "JSON Schema", but the file is OpenRPC, as the plan says.)
- No `~/.config/herdr-core/config.toml`, so the defaults apply: notes to parents are on and the wait timeout is 180 s.
- No `hc templates` are defined.

## 2. hc primitives

All of these are confirmed to exist and behave as the plan assumes, with the caveats listed.

### `hc run`
```
hc run [--bg] [--name N] [--cwd DIR] [--label K=V]... [--parent T | --no-parent]
       [--no-notify] [--outlive-parent] [--rm] [--keep] [--timeout S] [--json] <cmd|template> [task]
```
- `--bg` returns at once: `{"address":"t12","name":"disc-claude","parent":"t6","state":"live",...}`.
- **Names must match `[a-z0-9_-]{1,32}` and be unique among *live* terminals.** Task ids like `QHQ-12` are not valid names as they stand, so they need lowercasing (e.g. `w-qhq-12`).
- **The parent defaults to the terminal hc is started from** (via `$HC_TERMINAL_ID`). `--parent T` overrides it. This matters for us (see §5.2).
- `claude "<prompt>"` passes the first task as argv, so it can't be dropped the way an `hc send` to a booting agent can. Note: the launch reply had **no `first_message` field**, although `hc --skill` says to check `first_message.sent`. That's harmless for Claude because the prompt is argv, but it's a mismatch between hc's own docs and its behaviour.

### `--outlive-parent`: verified
A throwaway `sh` parent (`t8`) started two `sleep 90` children and then exited:
- `disc-orphan` with `--outlive-parent`: `die_with_parent: false`, **still live** after the parent exited.
- `disc-dies` without it: `die_with_parent: true`, ended with `reason: killed, signal: 1` (SIGHUP) when the parent exited.

### Parent notifications: verified
The core types a note into the **parent's terminal input**. For Claude Code that's a new user message, and it arrives mid-turn if the agent is busy:
```
<hc>t8 disc-parent exited (exit 0). Last lines:
t9 started
t10 started
parent-exit
Read: hc read t8</hc>
```
Per `hc --skill`, the core sends these notes when a child **can't report: blocked, error, or exited**. A turn that ends normally produces no note; I got none when my Claude child finished its turn. That fits the plan, because workers must `hc send` the coordinator themselves.

### `hc send` from worker to coordinator: verified
I told a Claude child (`t12`) to run `hc send t6 "disc-claude done: report at /dev/null"`. It arrived in this session tagged:
```
<hc from="t12 disc-claude">disc-claude done: report at /dev/null</hc>
```
`hc wait --children any` returned `{"reason":"message","from":"t12",...}`. `send` also has `--if idle|working`, `--wait` and `--force`. It refuses to type into a `blocked` program unless `--force`.

### `$HC_TERMINAL_ID`: verified
It's set in every core terminal and inherited by subprocesses (this session is `t6`). A child sees its own id (`HC_TERMINAL_ID=t7`) plus `HC_SCOPE` and `HC_TERMINAL_SOCKET=~/.local/state/herdr-core/default/default.sock`.

### Others
- `hc ls [--all] [--label K=V]... --json`: `{"terminals":[{address,name,agent,cwd,state,status,turn,parent,where}], "hidden_finished":N}`. **`--label` filtering** is what we'll use to find our workers.
- `hc get <t> --json`: full record, including `argv, parent, die_with_parent, keep, labels, state (live|finished), reason (exited|killed|...), exit_code, signal, status {app,state,msg}, status_ms, reported, title, turn`.
- `hc read <t> [--lines N]`: screen (plus N history lines) as text.
- `hc wait <t> | --children any|all [--timeout S]`: returns `{ended, reason: exit|status|message|timeout, status, exit_code, from?}`.
- `hc attach <t> [--observe]`; `hc kill`, `hc rm`, `hc label`, `hc keep`, `hc interrupt`, `hc keys`.
- Caveat: the `cwd` in `hc ls` isn't reliable. `t6` showed `~/Sites/jonathanfielding.com` while this session is in `~/Projects/herdr-coordinator-mod`. Store worktree paths ourselves.

### `hc events` format: verified
JSONL when piped. The first line is a snapshot `{"channel":null,"seq":N,"terminals":[...full records...]}`. After that, one JSON-RPC notification per change:
```json
{"jsonrpc":"2.0","method":"event","params":{"seq":264,"terminal":"t12","type":"status",
  "data":{"reported":true,"records":{},"status":{"app":"claude-code","state":"working","msg":"..."}}}}
```
Event types seen: `created`, `labels`, `foreground`, `title`, `status`, `turn` (`{"state":"done","turn":1}`), `size`, `finished` (`{exit_code, reason, signal}`), `removed`, plus bare `{"seq":N}` keepalives. Filters: `--terminal`, `--children-of`, `--label K=V`.

## 3. Mods

Sources: `~/.config/herdr-app/AGENTS.md`, `herdr-app --skill`, `herdr.d.ts`.

- **Layout:** `~/.config/herdr-app/mods/<name>/main.js` (required) plus an optional `mod.json` (`{"place": "right"|"left"|"top"|"bottom"|"none", "size": 320, "focusable"?: true}`), more `*.js` modules and `*.svg`. Saving any file hot-reloads the mod.
- **Language/runtime:** *"Mods use **gpui-kit** … JavaScript that describes **GPUI** elements … There's no DOM … You can't: use HTML, CSS, a web view, Node APIs or `setTimeout`."* The board is plain JS (no TS build step, no Bun). It's a class extending `View` with `init(props, cx)` and `render(cx)`. Timers go through `cx.timer`, async work through `cx.spawn`.
- **What it can do** (`herdr.d.ts`):
  - **Read files:** `readTextFile(path)` (UTF-8, ≤1 MiB, null if absent) and `fs/promises` (*"read in home, write under ~/.config/herdr-app"*). `~/.herdr-coordinator/...` is in home, so it's readable.
  - **Run programs:** `exec(cmd, args, {cwd})` (*"user's real environment … 30 s limit, 8 MiB output"*) and `hc(args)`. The board can call `hcoord task list --json` or `hc ls --label …`.
  - **Event-driven refresh, no timer:** `watchFolder(dir)` resolves with changed paths (recursive on macOS). Loop: `for(;;){ await watchFolder(projDir); reload(); cx.notify(); }`. Separately, *"`render(cx)` … runs again … whenever Herdr's live data changes (spaces, agents, terminals, focus …). Don't poll those."* `terminals()` gives every core terminal with labels and status, live. So worker status comes for free; only `tasks.json` needs the watch.
  - **Open/focus a terminal:** `run("terminal.peek", {terminal})` (peek over the tab, with keep-as-tab and close; the shipped `agents` mod uses this for sub-agents), `run("terminal.keep", {terminal, place?})` (give it a pane), `run("agent.focus", {terminal})`, `run("pane.focus", {terminal})`.
  - Also `notify({title, body, action})` toasts, `openOverlay`, `shared`/`setShared`, `props()`.
- **How it's enabled:** *"The first time Herdr sees a folder, it docks one copy per `mod.json` into the shown layout (`"none"`: only where a layout or another mod puts it)."* It can also be opened as a pane (`pane.split {direction, mod, props}`) or a tab (`tab.new {mod, props}`), and `props` can carry the project slug. Gate: `herdr-app check ~/.config/herdr-app/mods/<name>` must pass, then confirm visually with `herdr-app shot`.
- **Shipped vs. personal:** `installed.json` lists the shipped set (`agents, changes, confirm, files, help, machine-add, menu, new-menu, pane, peek, picker, prompt, spaces, tabs, terminals-bar, terminals-pane, toast, win98, workspace-chrome, workspace-status, worktree` and layouts `main, terminals, win98`). Yours: mod `quota`, layout `main-plus` (cloned from `main` 0.1.12). **No Board mod or layout ships with 0.1.12.** The closest is `agents`, which lists agents and sub-agents and peeks on click.
- **Visibility:** *"A terminal with [`herdr.space=<id>`/`herdr.tab=<id>`] labels shows up there … Unlabeled workers stay hidden."* Sub-agents started by an agent in a tab *"belong to their parent's tab without a pane; the `agents` mod shows them, `terminal.peek` opens one"*.

## 4. Status bridge: not needed

**Claude Code 2.1.316 reports OSC 7501 natively.** Evidence:
- The binary has `PROGRAM_STATUS: 7501` and builds `state=…[:id=…][:kind=…(blocked)][:progress=N][:title=…][:msg=…]`, plus `state=clear`. It probes support with `OSC 7501;?` first.
- Live test: `claude --setting-sources project "Reply with just the word OK…"` (user hooks off). The core recorded `status {app: "claude-code", state: "working"}` → `turn {state: "done"}` → `status.state: "done"`, `reported: true`, title `"OK reply"`. This session (`t6`) also shows up as `claude-code / working` with its current task as `msg`.
- None of your existing hooks emit 7501. `~/.claude/hooks/herdr-agent-state.sh` targets classic herdr (it exits unless `HERDR_ENV=1`). `~/.config/iterm2/cc-status` is an iTerm2 helper.

**Not yet verified:** a live `blocked` state. Claude ran in auto mode, so I couldn't get a permission prompt. The code path exists (`kind=` on blocked), and I'll check it in Phase 2/3.

## 5. Findings that change the plan

### 5.1 Bun isn't installed (blocks Phase 1 as written)

**Resolved 2026-11-02:** Bun 1.4.4 installed via `brew install oven-sh/bun/bun` (`/opt/homebrew/bin/bun`).

Options: (a) `brew install oven-sh/bun/bun`, keeping the plan as written. (b) TS on Node 24, which you already have via Volta (`--experimental-strip-types`, or `tsx`). **Recommendation: (a)**, since Bun is your stated default and `bun test` covers the unit tests. It needs your OK because it installs software.

### 5.2 Set the worker's parent explicitly
The parent defaults to whoever runs `hc run`. If a **worker's** `hcoord report` starts a queued task, that new worker's parent would be the reporting worker, so its notes (blocked/exited) would go to the wrong agent. **Change:** `hcoord task start` always passes `--parent <coordinator terminal>`, stored per project, and `--outlive-parent`. It never relies on the caller.

### 5.3 Find terminals by labels, not just names
Names are lowercase-only and unique only among live terminals. **Change:** label every worker `hcoord.project=<slug>`, `hcoord.task=<id>` and the coordinator `hcoord.role=coordinator`. Store `{address, name}` on the task. Recovery and the board use `hc ls --all --label hcoord.project=<slug>`. Terminal name: `w-<id lowercased>` (e.g. `w-qhq-12`).

### 5.4 `needs_you` can come from the core too
A worker stuck on a permission prompt can't run `hcoord report`. But the core reports `status: blocked` and sends the coordinator a note. **Change:** the coordinator skill (and `hcoord task list` when it reconciles) maps a live `blocked` worker to `needs_you` with reason "blocked in terminal (permission/question)", and maps `finished` without a report to `failed` with its exit code or signal.

### 5.5 Don't use `--keep` on workers
With keep, a lost worker is replaced by a shell under the same address. That hides the loss, and the status just goes null. Without keep, a lost terminal shows up as `finished` with a reason, so Phase 5 can mark it `failed` cleanly. The coordinator terminal can be kept, because a shell replacement there is harmless and you can relaunch it with `project open`. (Phase 5 still needs to confirm the exact `reason` value after a core restart.)

### 5.6 Where the coordinator lives in the window
`project open` should start the coordinator so the app shows it: `hc run --bg --keep --name coord-<slug> --label herdr.space=<id> --label herdr.tab=<id> --label hcoord.role=coordinator -- claude …`, or `herdr-app do tab.new --name coord-<slug> --argv '["claude",…]'`. The app command can't set an hc name, so I recommend labels + `hc run`. Workers then automatically appear as its sub-agents in the `agents` sidebar, and peek works with no extra code.

### 5.7 Your existing global Claude hooks will run in every worker

**Resolved 2026-11-02:** at your request, the herdr-projects and pixel-agents hooks were removed from `~/.claude/settings.json` (15 entries; backup `~/.claude/settings.json.bak-hooks-20261102-185216`). Still left: iTerm `cc-status`, read-once, and `herdr-agent-state.sh` (classic herdr, which does nothing outside it).

`~/.claude/settings.json` has hooks for **classic herdr-projects** (`SessionStart` and `PostToolUse` run `…/herdr-projects --root ~/.herdr-projects hook --agent claude`), pixel-agents and iTerm `cc-status`. Every coordinator and worker will fire them, and the herdr-projects one may write state into `~/.herdr-projects`. Options: leave them (harmless but noisy), launch our agents with `--setting-sources project,local` (this also drops your user model/env/plugins), or remove the old herdr-projects hooks yourself. **I won't touch `~/.claude`; this is your call.**

### 5.8 Board mod: build a new one
No Board ships, so "duplicate the Board layout" isn't possible. **Recommendation:** a new mod `mods/hcoord-board/` written from scratch, borrowing patterns from `agents` (read, not cloned, since it's a different idea). Project selection via `props.project` (pane/tab) with a fallback that matches the focused space's repo to `PROJECT.md`. Refresh = `watchFolder(~/.herdr-coordinator/projects/<slug>)` plus live `terminals()`. Click = `terminal.peek` (with a "keep as tab" option).

### 5.9 Minor
- `hcoord doctor` should check that `notes` isn't set to `false` in `~/.config/herdr-core/config.toml`. If it were, the coordinator would never be woken by blocked/exited children.
- Codex workers need `--no-daemon` (per `hc --skill`), so agent kind config should carry argv templates.
- Exec from mods has a 30 s limit, so the board should read files rather than shell out where it can.

## 6. Probe cleanup

All test terminals (`disc-env`, `disc-parent`, `disc-orphan`, `disc-dies`, `disc-claude`) were killed and removed. Nothing was written outside this repo except scratch files in the session temp dir. `~/.claude`, `~/.config/herdr*` and git config were not modified.

## 7. Found during Phases 2–3 (2026-11-02)

- **Claude folder trust is per git repo root.** A worktree takes its main repo's trust, so
  workers in a repo you've opened Claude in before never prompt. A brand-new folder, or a repo
  nested inside a trusted folder, shows "trust this folder?". While that dialog is up Claude
  reports **no status**, so the core sends no note and a worker would wait silently.
  hcoord now refuses `task start` for a repo Claude doesn't trust (read-only check of
  `~/.claude.json`), and right after any Claude launch it watches for the dialog for 20 s and
  marks the task `needs_you` if it sees it.
- **Notes to the parent only reach agents.** A plain program as parent gets `hc send` text
  (without the `<hc from=…>` tag) but not the core's exit/blocked notes.
- **No note for an ordinary end of turn.** Workers therefore get a session-only Stop hook
  (`--settings`, nothing written to `~/.claude`) that runs `hcoord worker-stopped <id>`.
- **`CLAUDE_CODE_CHILD_SESSION`** is inherited by anything started from a Claude session and
  turns off transcript saving; hcoord clears it for every agent it starts.
- **`--json` must go before `--`** in `hc run … -- <cmd>`, or it becomes the program's argument.
- A script can report status itself with `printf '\033]7501;state=blocked\007'`; `turn`
  increments when a working stretch ends.
- Herdr adopts a terminal labelled with an existing `herdr.space` and a new `herdr.tab` id
  within ~2 s, as a new unfocused tab with that id; `tab.rename --id` works; killing the
  terminal closes the tab.
- Tests run against a private core: `HC_SESSION` + `XDG_{STATE,CONFIG,RUNTIME}_HOME`, with the
  runtime dir short (macOS socket paths max 103 bytes) and `HC_TERMINAL_*` unset.

## 8. Phase 4 findings (Herdr Projects section)

- `mod.open {name}` shows a mod as an overlay. With no `overlay` size in `mod.json` it sizes to its content, and a
  `flex_1` scrolling list inside collapses to nothing; `"overlay": {"width", "height"}` fixes that.
- Reinstalling a mod (saving its files) closes its open overlay.
- A mod's `exec` takes no environment, so the installed `hcoord-path.js` names bun and `cli.ts` exactly (and goes
  through `env HCOORD_HOME=…` for a non-default root). The app's PATH doesn't matter. The repo's own `hcoord-path.js`
  is a default (`HCOORD = null`), so a plain copy of the folder loads and shows how to set hcoord up.
- `mutate` used to rewrite tasks.json even when nothing changed (schedule with only blocked queued tasks). With a
  folder watch on `projects/` that would loop; it now writes only when something changed.
- Verified in the real window: a click on a project with no space ran `space.new` + `hcoord project open`; Herdr took the
  coordinator into a tab "coord <slug>" and Claude ran the skill's first turn.
- Not yet verified by hand: `pickFolder` from the + button, and a toast `action: {name: "hcoord.adopt"}` reaching the
  mod's `nextCommand()`.
