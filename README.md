<h1 align="center">herdr-coordinator</h1>

<h3 align="center">Hand a whole feature to a team of coding agents, and only hear about the parts that need you</h3>

<p align="center">herdr-coordinator (<code>hcoord</code>) adds a <b>Projects</b> section to the <a href="https://herdr.dev">Herdr</a> sidebar. You talk to one coordinator agent per worktree. It splits your request into small tasks, starts a separate Claude Code worker for each one on its own branch and checkout, and merges each worker's branch back into your worktree when it's done. The sidebar shows which tasks need you, which are working and which have merged.</p>

<p align="center"><sub>✓&nbsp;Runs&nbsp;on&nbsp;your&nbsp;machine,&nbsp;no&nbsp;hosted&nbsp;service &nbsp; ✓&nbsp;State&nbsp;in&nbsp;plain&nbsp;files &nbsp; ✓&nbsp;Never&nbsp;pushes&nbsp;or&nbsp;deletes&nbsp;branches &nbsp; ✓&nbsp;macOS,&nbsp;Claude&nbsp;Code,&nbsp;Bun</sub></p>

<br />

## One conversation, many workers

The coordinator never writes code itself, so it's always free to answer you. Each task runs in a worker: a separate Claude Code session in its own git checkout, on its own branch, with a self-contained brief. Workers report back when they finish, get stuck or have a question. The coordinator reads those reports, answers what it can from your standing instructions, and passes on only what needs you.

```
Project (one git repo)
 ├─ worktree "root" (the main checkout)   ← its own coordinator
 ├─ worktree "feature-login"              ← its own coordinator
 │    ├─ worker SHP-3  branch coord/feature-login/shp-3-…  merged back into feature-login
 │    └─ worker SHP-4  …
 └─ …
```

## Why not just run agents yourself?

| | **hcoord** | Briefing agents by hand | One long agent session |
|---|:---:|:---:|:---:|
| **Parallel tasks on separate branches** | ✅ | ✅ | ❌ |
| **A conversation that stays free to answer** | ✅ | ❌ | ❌ |
| **Finished work merged back for you** | ✅ | ❌ | n/a |
| **Same standing instructions and memory for every task** | ✅ | ❌ | ✅ |
| **Tasks grouped by what needs you, in the sidebar** | ✅ | ❌ | ❌ |
| **Picks up after a reboot** | ✅ | ❌ | ❌ |
| **Runs on your own machine** | ✅ | ✅ | ✅ |

You keep your attention on decisions. hcoord starts and tracks the workers, Claude does the work, and you choose what to look at, answer or keep.

## What it looks like in Herdr

```
PROJECTS                                   📁
▾ shop                                     2  +
    root · main                          ○
    feature-login                        ⟳
      Needs you  ! SHP-3 Users API …
      Working    ⟳ SHP-4 Users page      ≡
      Merged 3
```

### 📋 Every task, grouped by what it needs

Under each project are its worktrees. Under each worktree are its tasks, grouped as **Needs you**, **Working**, **Queued**, **To do**, **Failed**, **Not merged** and **Merged**. A folded project shows a red count of what needs you. Click a running task to peek at its worker's terminal, or a finished one to read its log.

### ⚡ Brief once

Say what you want in the coordinator's pane. It decides which files each task owns, so two workers running at once never edit the same file, and chains tasks that depend on each other. Each worker starts with a brief that includes the task, the files it owns, how to test (from `PROJECT.md`) and how to report. Decisions worth keeping go into `MEMORY.md`, which every coordinator in the project reads.

### 🔀 Work lands on your branch

When a worker reports done, hcoord merges its branch into the worktree's branch with `git merge --no-ff`. If there's a conflict, or uncommitted changes of yours in the way, the merge is aborted and nothing in your worktree changes. The task shows up under **Not merged**, and the coordinator suggests how to resolve it.

### 💬 Questions reach you, prompts don't hide

A worker that has a question reports `needs_you`, and the question comes to you through the coordinator. A worker that stops without reporting, or sits silent at a prompt in its terminal, is caught as well and shows up under **Needs you** rather than looking busy.

### 📜 Readable logs

Every agent hcoord starts gets its own Claude session. The log icon opens its transcript in a Herdr pane, rendered as markdown: the agent's messages, each tool call with a short result, and the worker's reports. The pane updates as the agent works.

## Get started in three steps

<table>
<tr>
<td align="center" valign="top" width="33%"><h3>1️⃣</h3><b>Install</b><br /><sub>Paste one line into Claude Code, or clone this repo and follow a few steps. See <a href="#install">Install</a> below.</sub></td>
<td align="center" valign="top" width="33%"><h3>2️⃣</h3><b>Make a project</b><br /><sub>Click the folder button in the Projects header and pick a folder. If it isn't a git repo yet, you're asked whether to set one up, with a first commit of its files. Its coordinator starts in that checkout. Put how to test and your conventions in the project's <code>PROJECT.md</code>.</sub></td>
<td align="center" valign="top" width="33%"><h3>3️⃣</h3><b>Tell it what you want</b><br /><sub>Describe the work in the coordinator's pane. It tells you the plan, starts the workers and ends its turn. The sidebar shows each task as it moves along.</sub></td>
</tr>
</table>

## Install

The quickest way is to paste this into Claude Code:

```
Read ~/.config/herdr-app/AGENTS.md, then install https://github.com/jonathan-fielding/herdr-project-coordinator by following the Install section of its README.
```

Or do it yourself with the steps below.

### 1. Check you have the prerequisites

- macOS
- the Herdr app, with herdr-core (`hc`) on your `PATH`
- [Claude Code](https://claude.com/claude-code) (`claude`), signed in
- git
- [Bun](https://bun.sh): `curl -fsSL https://bun.sh/install | bash`

### 2. Get the code and the `hcoord` command

```sh
git clone https://github.com/jonathan-fielding/herdr-project-coordinator.git
cd herdr-project-coordinator
bun install

# put `hcoord` on your PATH: a small shim that runs this checkout's CLI with Bun
mkdir -p ~/.local/bin
printf '#!/bin/sh\nexec %s %s/src/cli.ts "$@"\n' "$(command -v bun)" "$PWD" > ~/.local/bin/hcoord
chmod +x ~/.local/bin/hcoord
hcoord --version
```

If `hcoord` isn't found, add `~/.local/bin` to your `PATH` (herdr-core's `hc` usually lives there too).

Keep the clone where it is. The Projects section and every agent run hcoord from this folder, and coordinators load the skill from `plugin/` here, so there's no separate plugin to install.

### 3. Install the Projects section

```sh
hcoord mod install
herdr-app check ~/.config/herdr-app/mods/hcoord
```

This copies the section to `~/.config/herdr-app/mods/hcoord`. Run `hcoord mod install` again after you pull changes or edit `mods/hcoord/`. Don't edit the installed copy: the next install overwrites it.

### From the Herdr mod gallery

Herdr's gallery copies `mods/hcoord/` into `~/.config/herdr-app/mods/hcoord` and runs `herdr-app check`. That gives you the Projects section and nothing else: the section is a front end for the `hcoord` CLI, which the gallery doesn't install. Until the CLI is set up, the section says so and links here.

To finish, do steps 1 and 2 above, then run `hcoord mod install`. It takes over the gallery copy and records where your bun and `cli.ts` are. Step 4 still applies: the gallery doesn't place the section in your sidebar either.

### 4. Add the section to your sidebar

Herdr doesn't place the section by itself, so you add it to a layout. Herdr's shipped layouts are replaced on update, so make your own copy of `main` first (skip this if you already have one):

```sh
herdr-app do layout.clone '{"name":"main","as":"main-plus"}'
```

That switches Herdr to the copy. Open `~/.config/herdr-app/layouts/main-plus.json`, find the sidebar column that holds the `spaces` and `agents` blocks, and add this block between them:

```json
{
  "id": "projects",
  "type": "block",
  "content": { "mod": "hcoord" },
  "size": { "weight": 1 },
  "min": 90
}
```

Herdr picks up the change within a second, and **Projects** appears in the sidebar.

### 5. Trust your repos in Claude Code

Workers can't start in a repo Claude Code hasn't been told to trust, because they'd wait at its "trust this folder?" prompt. Run `claude` in each repo once and choose "Yes, I trust this folder". The Projects section shows a red row on any project that isn't trusted yet; clicking it opens Claude there for you.

### Updating

```sh
cd herdr-project-coordinator
git pull
bun install
hcoord mod install
```

Running coordinators and workers keep going. A coordinator picks up a changed skill when it next starts: quit it (`/exit` in its terminal), then click its worktree or run `hcoord lane open <worktree path>`, and a fresh Claude carries on the same conversation. `--restart` won't do this, because it leaves a running coordinator alone.

## Using the Projects section

**Project rows**
- Click to fold or unfold. `+` asks for a new branch name (and, optionally, where it starts: the default branch unless you say otherwise), makes the branch and its worktree in `~/.herdr/worktrees/<repo>/`, and opens it in a space of its own with its coordinator already in it. Worktrees made elsewhere (Herdr's own New worktree, `git worktree add`) get a coordinator when you open their space.
- The cog beside `+` opens that project's settings. **Cleanup prompt** takes several lines: when a worktree of the project is deleted, its coordinator runs this prompt before the folder is removed. Every worktree of the project shares it.
- Right-click for **New worktree** and **Delete project…**.
- Drag a project's row up or down to reorder projects; the order is kept.

**Worktree rows** show the branch and the coordinator's state:

| Mark | Meaning |
|---|---|
| hollow dot | no coordinator running |
| spinner | coordinator is working |
| **Needs you** | coordinator is waiting on you |
| filled dot | coordinator finished its turn |
| square | stopped by a restart: its terminal came back as an empty shell |
| terminal icon | something other than the coordinator is running in its terminal, such as a plain Claude you started there yourself |
| **?** | the coordinator is running but reports no status (at a prompt such as Claude's trust question, or still starting) |

- The default branch comes first, above the main checkout, even when nothing has it checked out (clicking it then makes its worktree).
- Click to go to the worktree's space and coordinator. If none is running, one starts, resuming its last conversation when there is one. Switching to the worktree's space does the same, once a minute at most.
- **Raise PR** (on a row whose branch isn't the default one, and in its right-click menu) asks the worktree's coordinator to raise a PR against the default branch, bringing it back first if it's stopped.
- The log icon opens the coordinator's transcript. Right-click for **Coordinator's log** and **Delete worktree…**.
- **Stopped by a restart: click to bring back** shows under a stopped worktree, even when it's folded. Click it or the worktree: the coordinator carries on its conversation, or starts a new one if it has none to carry on.
- **N coordinators stopped: bring back** shows under a project with more than one stopped. Click to bring them back one at a time, leaving you where you are.
- **Plain Claude running, not the coordinator** shows, even when folded, if you've started Claude yourself in a stopped coordinator's terminal. Another program is named the same way, such as **vim running, not the coordinator**, and **Something else is running in its terminal: exit it first** means hcoord can't tell what it is. Click to look at it. Bringing a coordinator back never stops what's running there, so `/exit` that Claude or exit the program yourself, then click the worktree. The coordinator's own saved conversation comes back, not that Claude's session, which stays in its own transcript.
- **Coordinator reports no status: look at it** lets you peek at a silent coordinator. The button at the end replaces it with a fresh Claude that carries on the same conversation.
- **N workers lost: carry on** appears when workers' terminals have gone (after a reboot, say). Click to restart each one in its existing checkout, picking up from its commits.

**Task groups**

| Group | Meaning |
|---|---|
| Needs you | the worker asked a question, or is stuck at a prompt in its terminal |
| Working | the worker is running |
| Queued | waiting for a free slot (3 per project by default) or for its dependencies to merge |
| To do | added but not started |
| Failed | the worker failed, or its terminal disappeared |
| Not merged | done, but the merge hit a conflict or local changes |
| Merged | done and merged (cancelled tasks too); folded by default |

**Narrow sidebar.** When the sidebar is collapsed to a rail, each project becomes one line: its task prefix, then a red count, a spinner or a hollow dot. Click it to go to the main checkout's coordinator.

**Things that happen without a click**
- Going to a project's worktree space starts its coordinator if it isn't running, at most once a minute per worktree.
- A new space in a git repo that isn't a project gets one notification offering to make it one.
- When workers' terminals change, the section runs `hcoord sync`. That marks exited workers failed and blocked ones needs-you, and starts queued tasks that can now run.
- The list refreshes when the data folder changes or a new space opens in a known repo, and every 8 seconds otherwise.

**Deleting.** Both deletes ask first and list exactly what will happen.
- **Delete project…**
  - **Remove from Herdr** stops its coordinators, cancels unfinished tasks and moves its hcoord data to `~/.herdr-coordinator/deleted/`. The repo stays on disk.
  - **Delete files too** also moves the repo, its worktrees and the workers' checkouts to the Trash. The dialog warns about uncommitted files and commits that haven't been pushed.
- **Delete worktree…** stops its coordinator, cancels its unfinished tasks, closes its space and runs `git worktree remove`. The branch is kept.

**Warnings.** A red line under the header means something's wrong with the setup, such as a data folder macOS may empty. Click it for the cause and the fix.

## Questions

### Will it touch my branches on its own?

Only to merge. When a worker reports done, hcoord merges that worker's branch into the worktree it belongs to, locally. If the merge can't go through cleanly it's aborted, and your worktree is left exactly as it was. hcoord never pushes, rebases or deletes a branch. `hcoord task clean` removes a worker's checkout only when git says it's clean and merged, and it keeps the branch. Deleting a worktree or a project from the sidebar always asks first.

### What can the coordinator do without asking?

A coordinator starts with `hcoord` and the read-only herdr-core commands (`hc ls`, `hc get`, `hc read`) allowed. Some commands are denied even if your own Claude settings allow them: deleting projects or worktrees, and killing, typing into or starting terminals (`hc kill`, `hc rm`, `hc keys`, `hc send`, `hc run`). The coordinator skill also tells it never to edit code or change git state. Workers keep Claude's normal permission prompts, with only `hcoord report` allowed up front. Add flags such as `["--permission-mode", "acceptEdits"]` through `agent.workerArgs` in `config.json` if you want them to ask less.

### How do I check it's working?

`hcoord board` lists every project and its tasks, and prints any setup warnings. `herdr-app check ~/.config/herdr-app/mods/hcoord` checks the installed section. If a worker seems stuck, `hcoord task show <id>` shows its terminal, and `hcoord log <id>` shows what it did.

### What happens after a reboot?

Nothing resumes by itself when Herdr starts, because each coordinator that comes back uses a Claude turn. You choose what comes back and when.

A stopped coordinator shows a square and **Stopped by a restart: click to bring back**. Click that, or switch to its space, and it carries on its conversation, or starts a new one if its transcript has gone. The space that's focused when Herdr starts doesn't count as a switch, so it waits for a click. With more than one stopped, **N coordinators stopped: bring back** does a whole project, one at a time, and leaves you where you are. A coordinator whose terminal has gone altogether shows a hollow dot, and a click or a switch to its space brings that back too.

If something else is running in a stopped coordinator's terminal, such as a plain Claude you started there yourself, hcoord won't stop it. The row says what's there. `/exit` it or exit the program, then click the worktree. The coordinator's own conversation comes back, not that Claude's session.

Click **N workers lost: carry on** to restart workers in their checkouts. That line appears once hcoord next checks its workers, and bringing a coordinator back makes it check.

`hcoord recover` does all of this from a terminal, for every project in one go: it brings back every coordinator that isn't running and retries lost workers. If something else is running in a coordinator's terminal, or a coordinator is at a prompt or still starting, it reports that, leaves it alone and exits with 1.

### Does anything leave my machine?

hcoord itself talks only to your local herdr-core and git. Claude Code still uses Anthropic's service as usual.

### What does it cost?

hcoord adds no fee. Each coordinator and worker is a full Claude Code session, so they use your Claude plan or API usage like any other session. `maxParallel` caps how many workers run at once per project.

### Can I use another agent instead of Claude Code?

Not fully yet. `agent.kind: "generic"` starts any program with the prompt as its last argument, but the coordinator skill, transcripts and the stop-without-reporting check are built for Claude Code. Codex isn't supported yet.

## Reference

### Data and settings

Everything lives in `~/.herdr-coordinator/` (`HCOORD_HOME` overrides it):

```
config.json                 settings
projects/<slug>/
  project.json              repo, worktrees, coordinators
  tasks.json, TASKS.md      tasks (TASKS.md is a generated board, one section per worktree)
  PROJECT.md                your standing instructions
  MEMORY.md                 notes shared by every coordinator in the project
  reports/<ID>.md           worker reports
  events.log
worktrees/<slug>/<ID>/      workers' checkouts
```

| `config.json` key | Default | Meaning |
|---|---|---|
| `maxParallel` | `3` | workers running at once per project; more tasks wait as queued |
| `worktreeRoot` | `~/.herdr-coordinator/worktrees` | where workers' checkouts go |
| `agent.command` | `["claude"]` | the agent program |
| `agent.workerArgs` | | extra arguments for workers, e.g. `["--model", "sonnet"]` |
| `agent.coordinatorArgs` | | extra arguments for coordinators |

### The CLI

The section and the coordinators drive it, so you rarely need it. `hcoord --help` lists everything.

| Command | Does |
|---|---|
| `hcoord project new <name> --repo <path>` | make a project |
| `hcoord lane open [<path>] [--restart] [--no-focus]` | start, resume or show the coordinator of the worktree at `<path>`. A stopped one resumes with no flag. `--restart` only replaces one that reports no status: a running one is left alone, and what else runs in its terminal is never stopped. `--no-focus` leaves the focus where it is (with `--json`, prints the coordinator's terminal) |
| `hcoord lane say <path> <text>` | tell the worktree's coordinator something, as if typed to it (started first if it isn't running; refused if something else runs in its terminal) |
| `hcoord lane new <branch> [<slug>] [--base <ref>]` | a new branch (from the default branch, or `<ref>`) and its worktree, registered. A base branch on origin is fetched first, so the branch starts from up-to-date code (a failed fetch warns and uses the local copy) |
| `hcoord lane branches [<slug>] [--json]` | the branches a new one can start from: local ones, plus origin's with no local branch, by name, the default marked |
| `hcoord board` | every project and its tasks |
| `hcoord task list` / `task show <id>` | tasks and their state |
| `hcoord task add` / `task start <id>` | add a task and start its worker |
| `hcoord task reply <id> <text>` | answer a worker that needs you |
| `hcoord task merge <id>` | retry a merge after a conflict |
| `hcoord task retry <id>` / `cancel` / `clean` | rerun, stop, or remove a merged task's checkout |
| `hcoord log <id>` | a worker's transcript and reports, as markdown |
| `hcoord recover [<slug>]` | after a reboot: bring back every coordinator that isn't running and retry lost workers, in every project or just `<slug>`. A coordinator that reports no status, or a terminal with something else running in it, is reported and left alone, and the exit code is 1 |

### How it's built

- `mods/hcoord/`: the Projects section, a Herdr mod. It reads `hcoord board --json` and calls the CLI for everything else. The repo is shaped the way Herdr's mod gallery expects, so this folder loads when simply copied; `hcoord-path.js` holds a default there, and `hcoord mod install` writes the real path into the installed copy only.
- `plugin/`: the coordinator skill, loaded into each coordinator with `--plugin-dir`, so there's nothing extra to install.
- `src/`: the `hcoord` CLI. It starts agents through herdr-core and keeps state in the data folder.
- `docs/`: `discovery.md` covers how herdr-core behaves, and `design-worktrees.md` covers the worktree model.

```sh
bun test
bun run typecheck
```
