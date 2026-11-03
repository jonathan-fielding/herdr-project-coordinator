# herdr-coordinator (hcoord)

A project coordinator for the [Herdr](https://herdr.dev) desktop app. You talk to one coordinator agent per worktree in plain language. It splits your request into small tasks and starts one worker agent per task. Each worker gets its own branch and checkout, and its work is merged back into your worktree when it's done. You only hear about the things that need you.

It has three parts:

- **The Projects section** (`mod/hcoord`): a Herdr sidebar section beside Spaces and Agents. This is where you'll spend most of your time.
- **The coordinator skill** (`plugin/`): a Claude Code plugin that tells the coordinator agent how to plan, start workers and react to their reports.
- **The `hcoord` CLI** (`src/`): keeps tasks, starts workers through herdr-core (`hc`) and merges their branches. The section and the agents both use it. State is kept in plain files.

## How it fits together

```
Project (one git repo)
 ├─ worktree "root" (the main checkout)   ← its own coordinator
 ├─ worktree "feature-login"              ← its own coordinator
 │    ├─ worker SHP-3  branch coord/feature-login/shp-3-…  merged back into feature-login
 │    └─ worker SHP-4  …
 └─ …
```

- A **project** is one git repo.
- A **worktree** is a checkout of that repo: the main checkout, or a linked worktree (one of Herdr's worktree spaces). Each worktree has its own **coordinator**, a Claude Code session running in that folder.
- A **task** belongs to one worktree. When it starts, hcoord makes a branch off the worktree's current HEAD and a separate checkout for it, then starts a **worker** there.
- When a worker reports done, hcoord merges its branch into the worktree's branch (`git merge --no-ff`). If there's a conflict, or uncommitted changes in the way, the merge is aborted and the task stays in **Not merged** until it's resolved. Branches are never deleted or pushed.

## Using it in Herdr

### The Projects section

```
PROJECTS                                   📁
▾ shop                                     2  +
    root · main                          ○
    feature-login                        ⟳
      Needs you  ! SHP-3 Users API …
      Working    ⟳ SHP-4 Users page      ≡
      Merged (3)
```

**Project rows**
- Click to fold or unfold. A folded project shows a red count of tasks that need you.
- `+` opens Herdr's New worktree dialog for the repo. Opening the new worktree's space starts a coordinator for it.
- Right-click: **New worktree**, or **Delete project…**.
- If Claude Code doesn't trust the repo yet, a red row says so. Its agents would stop at Claude's "trust this folder?" prompt. Click the row to open Claude in the repo and answer the prompt yourself.

**Worktree rows** show the branch and the coordinator's state:

| Mark | Meaning |
|---|---|
| hollow dot | no coordinator running |
| spinner | coordinator is working |
| **Needs you** | coordinator is waiting on you |
| filled dot | coordinator finished its turn |
| **?** | the terminal runs but reports no status (a prompt, or a plain shell after a restart) |

- Click to go to the worktree's space and coordinator. If no coordinator is running, one is started, resuming its previous conversation when there is one. If the worktree has no space, one is made.
- The log icon opens the coordinator's transcript.
- Right-click: **Coordinator's log**, or **Delete worktree…**. The main checkout can't be deleted on its own; delete the project instead.
- **Coordinator reports no status: look at it** appears when the terminal is alive but silent. Click to peek at it. The button at the end replaces it with a fresh Claude that carries on the same conversation.
- **N workers lost: carry on** appears when workers' terminals have gone (after a reboot, say). Click to restart each one in its existing checkout.

**Task rows** sit under their worktree, grouped by state:

| Group | Meaning |
|---|---|
| Needs you | the worker asked a question, or is stuck at a prompt in its terminal |
| Working | the worker is running |
| Queued | waiting for a free slot (3 per project by default) or for the tasks it depends on to merge |
| To do | added but not started |
| Failed | the worker failed, stopped without reporting, or its terminal disappeared |
| Not merged | done, but the merge hit a conflict or local changes |
| Merged | done and merged (cancelled tasks are here too); folded by default |

- Click a running task to peek at its worker's terminal. Click a finished one to open its log.
- The log icon opens the transcript in a pane to the right. It shows the agent's messages, each tool call with a short result, and the worker's reports, and it updates as the agent works.

**When the sidebar is narrow** (the rail), each project becomes one line: its task prefix, plus a red count, a spinner or a hollow dot. Clicking it goes to the main checkout's coordinator.

### Things that happen without a click

- **Going to a worktree's space starts its coordinator** if it isn't running. It won't retry the same worktree more than once a minute.
- **A new space in a git repo that isn't a project** shows a notification offering to make it one. Each repo is offered once; after that, use the folder button.
- **Worker terminals changing** (finishing, blocking, exiting) makes the section run `hcoord sync`. That marks vanished or exited workers as failed and blocked ones as needs-you, and starts queued tasks that can now run.
- **The list refreshes** whenever the data folder changes, and every 30 seconds otherwise.

### Making a project

Click the folder button in the section header and pick a folder inside a git repo. hcoord registers the repo as a project (named after the folder), opens the checkout you picked and starts its coordinator. Then tell the coordinator what you want done.

Each project's folder has a `PROJECT.md` for standing instructions, such as how to run the tests or which conventions to follow. Every coordinator and worker in the project reads it.

### Deleting

Both deletes ask first, and the dialog lists exactly what will happen before anything does.

- **Delete project…** offers two choices:
  - **Remove from Herdr** stops the project's coordinators and cancels unfinished tasks. Its hcoord data (tasks, reports, notes, logs) moves to `~/.herdr-coordinator/deleted/`. The repo and its worktrees stay on disk.
  - **Delete files too** does that, then also moves the repo, its worktrees and the workers' checkouts to the Trash and closes their spaces. The dialog warns about uncommitted files and commits that haven't been pushed.
- **Delete worktree…** stops its coordinator, cancels its unfinished tasks, closes its space and runs `git worktree remove`. The branch is kept. The dialog warns if uncommitted files would be lost.

### Warnings

A red line under the header means something's wrong with the setup, for example that hcoord's data folder is somewhere macOS may empty. Click it for an explanation and the fix.

## Talking to a coordinator

A coordinator plans and keeps track; workers write the code. A coordinator never edits code, runs builds, changes git state or presses keys in a worker's terminal. When you give it a request, it:

1. asks you first if the request is ambiguous in a way that changes the plan;
2. splits it into small tasks, deciding which files each task owns so that tasks running at the same time never touch the same file (ones that must are chained with dependencies);
3. starts them and tells you the plan in a few lines;
4. ends its turn. It doesn't poll. hcoord wakes it when a worker reports.

When a worker reports, the coordinator tells you only about tasks that merged, failed or need you, one line each. It answers workers' questions itself when `PROJECT.md`, `MEMORY.md` or something you already said covers them, and asks you otherwise.

You can also ask it "what's going on?", "what did SHP-3 do?", or to cancel, retry or clean up a task. It saves lasting decisions and preferences to `MEMORY.md`, which every coordinator in the project reads.

## Setup

Requirements: macOS, the Herdr app with herdr-core (`hc`), Claude Code, git and [Bun](https://bun.sh).

```sh
bun install
bun link                      # puts `hcoord` on your PATH (or run `bun src/cli.ts`)
hcoord mod install            # copies the Projects section to ~/.config/herdr-app/mods/hcoord
```

Then add the section to a Herdr layout you own:

```json
{ "id": "projects", "type": "block", "content": { "mod": "hcoord" } }
```

The installed mod runs hcoord with the same Bun and the `cli.ts` from this checkout, so don't move the repo after installing. Edit the mod here and run `hcoord mod install` again; don't edit the installed copy.

Coordinators are started with this repo's `plugin/` loaded through `--plugin-dir`, so there's nothing extra to install for the skill.

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

`config.json` settings:

| Key | Default | Meaning |
|---|---|---|
| `maxParallel` | `3` | workers running at once per project; more tasks wait as queued |
| `worktreeRoot` | `~/.herdr-coordinator/worktrees` | where workers' checkouts go |
| `agent.command` | `["claude"]` | the agent program |
| `agent.workerArgs` | | extra arguments for workers, e.g. `["--model", "sonnet"]` |
| `agent.coordinatorArgs` | | extra arguments for coordinators |

## The CLI

You rarely need it directly; the section and the coordinators drive it. `hcoord --help` lists everything. The main commands:

| Command | Does |
|---|---|
| `hcoord project new <name> --repo <path>` | make a project |
| `hcoord lane open [<path>]` | start or show the coordinator of the worktree at `<path>` |
| `hcoord board` | every project and its tasks |
| `hcoord task list` / `task show <id>` | tasks and their state |
| `hcoord task add` / `task start <id>` | add a task and start its worker |
| `hcoord task reply <id> <text>` | answer a worker that needs you |
| `hcoord task merge <id>` | retry a merge after a conflict |
| `hcoord task retry <id>` / `cancel` / `clean` | rerun, stop, or remove a merged task's checkout |
| `hcoord log <id>` | a worker's transcript and reports, as markdown |
| `hcoord recover` | after a reboot: bring coordinators back and retry lost workers |

## Development

```sh
bun test
bun run typecheck
```

Design notes are in `docs/`: `discovery.md` covers how herdr-core behaves, and `design-worktrees.md` covers the worktree model.
