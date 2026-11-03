# Investigation: why the Projects sidebar is slow to show a new worktree

Task HCM-5. Read-only investigation; no code changed. Line numbers are as of commit 91643f6.

## Summary

The sidebar reloads its data on exactly three triggers. One is a change under `~/.herdr-coordinator/projects`. Another is a 30-second timer. The last is something hcoord itself did from the sidebar. A new worktree is a change to **git's** data (`<repo>/.git/worktrees/…`). It touches nothing under `~/.herdr-coordinator/projects`. So when a worktree is made outside the sidebar's own hcoord calls, the only thing that picks it up is the 30-second fallback timer. That covers Herdr's own New worktree dialog (the project row's `+`), `git worktree add` in a terminal, and a branch switch in an existing checkout. The worst-case delay is about **30 s** plus one `hcoord board` run, and the average is about 15 s.

There's also a second effect that makes it feel worse. Herdr's New worktree dialog makes the checkout and a space, then focuses that space. The sidebar checks the new space against its **stale** data and finds no matching worktree, so it never starts the coordinator. It also marks the space as already handled, so the coordinator isn't started when the data catches up either. The person has to click the row or switch spaces away and back.

The data itself is cheap to load (about 45 ms in-process, about 60 ms as `bun src/cli.ts board --json`). Expensive git calls and caching aren't the problem. Nothing is cached between runs.

## The refresh path, end to end

### 1. What the sidebar shows and where it comes from

- The mod holds one snapshot, `this.data`. It's the parsed output of `hcoord board --json` (`mod/hcoord/main.js:80`, `:122-124`).
- Worktree rows come from `worktrees(p)` (`mod/hcoord/main.js:195-211`), which uses three fields of that snapshot:
  - `p.checkouts`: every checkout git knows, from `listWorktrees(meta.repo)`, i.e. `git worktree list --porcelain` (`src/board.ts:95-97`, `src/git.ts:63-73`). hcoord's own worker checkouts are left out.
  - `p.lanes`: registered worktrees from `project.json` (`src/board.ts:109-117`).
  - `p.defaultBranch`: from `defaultBranch()` (`src/board.ts:101-108`, `src/git.ts:25-33`).
- `board()` only reads; it never caches or writes anything (`src/board.ts:87-133`). Each run spawns a fresh `bun`. For each project it runs `git worktree list`, `git symbolic-ref`, maybe `git config` and a few `git show-ref`s, and parses `~/.claude.json` once (`src/agents.ts:115-132`). There's no stale cache anywhere in this path.
- The sidebar doesn't list branches. It lists checkouts, plus the default branch when nothing has it checked out. A new branch with no worktree never shows up, by design (`docs/design-worktrees.md:66-72`). "New branch" in practice means a new worktree on that branch, or a checkout that switched branch.

### 2. What makes it reload (`refresh`, `mod/hcoord/main.js:112-134`)

`refresh()` runs `hcoord board --json`. If a run is already going, it queues one more (`this.again`). Its callers:

| Trigger | Where | Fires on a new worktree? |
|---|---|---|
| Mod start | `main.js:96` | once |
| Fallback timer, every `FALLBACK_MS = 30000` | `main.js:25`, `:97` | **yes, the only thing that does for outside-made worktrees** |
| Folder watch on `${root}/projects` (recursive on macOS, `docs/discovery.md:84`) | `main.js:136-151` | only if hcoord writes `project.json` / `tasks.json` |
| After `hcoord sync`, when a watched agent terminal changes state | `main.js:154-183` (`:181`) | no (it watches coordinators' and active workers' terminals only) |
| After the sidebar's own hcoord calls: `go()` / `lane open` / `lane checkout`, adopt, retry | `main.js:257`, `:282`, `:348`, `:592` | yes, when the worktree was made through these |

The comment on the timer says what it's for: *"Changes the folder watch can't see (Claude's trust list, new git worktrees): looked for this often."* (`main.js:24`). The README says the same (`README.md:201`: *"refreshes when the data folder changes, and every 30 seconds otherwise"*).

`render()` runs again whenever Herdr's live data changes (spaces, terminals, focus; `docs/discovery.md:84`). It calls `maybeSync` and `followSpace` (`main.js:693-694`) but **never `refresh()`**. A new space appearing redraws the sidebar from the old snapshot.

### 3. Why the folder watch misses new worktrees

- The watch covers `~/.herdr-coordinator/projects` only (`main.js:137`).
- `git worktree add` writes `<repo>/.git/worktrees/<name>/` and maybe `refs/heads/<branch>`. A branch switch writes `.git/HEAD` or `.git/worktrees/<name>/HEAD`. None of that is under the watched folder.
- hcoord writes under `projects/` only when it **registers** a worktree as a lane. That happens in `laneForPath()` → `updateMeta()` → `atomicWrite(project.json)` (`src/coordinator.ts:64-89`, `:78-87`; `src/store.ts:111-121`), which runs on `hcoord lane open` / `lane checkout` (`src/cli.ts:191-198`, `:222-230`). Registration happens when a coordinator is first started for the worktree, not when the worktree is made.

### 4. The three ways a worktree gets made

**a. The sidebar's virtual default-branch row (through hcoord): fast.**
`go()` runs `hcoord lane checkout`, which runs `git worktree add` and `laneForPath` (writes `project.json`). Then it runs `hcoord lane open`, then `this.refresh()` (`main.js:243-283`). Both the folder watch and the explicit refresh fire. The delay is about one board run (under 1 s).

**b. The project row's `+` → Herdr's New worktree dialog: slow (≤ 30 s), and no coordinator.**
`newWorktree()` only opens Herdr's `worktree` mod dialog (`main.js:301-305`). Nothing calls `refresh()` afterwards. Herdr makes the checkout under `~/.herdr/worktrees/<repo>/<branch>` and a space for it, then focuses it. Then:

1. `render()` → `followSpace()` (`main.js:286-299`) sees a new focused space. It sets `this.space = now` and asks `worktreeAt(place)`. That reads the stale `this.data`, which has no checkout containing the new folder, so it returns null and nothing happens (`main.js:294`).
2. Within about 2 s, `lookAtNewSpaces()` (`main.js:352-385`) looks at the space. `worktreeAt` is still null (`:364`), so it runs `git rev-parse --git-common-dir`. That finds the repo is already a project (`:371`), so it returns silently. It adds the space to `seenSpaces` (`:361`) and doesn't call `refresh()`.
3. Up to 30 s later, the fallback timer refreshes. The new checkout appears in `p.checkouts` and the row shows, with "No coordinator yet: click to start one." (`main.js:600`).
4. `followSpace()` doesn't run again for that space, because `now === this.space` (`main.js:288`). The design says going to a worktree space starts its coordinator (`docs/design-worktrees.md:72`; `main.js:285`), but here that waits until the person switches away and back, or clicks the row.

**c. `git worktree add` in a terminal, or `git switch` in a checkout: slow (≤ 30 s).**
Nothing under `projects/` changes and no Herdr space appears, so only the fallback timer notices. Branch switches in a registered worktree show their new name the same way, because `BoardLane.branch` and `checkouts[].branch` come from `git worktree list` (`src/board.ts:114`).

Worker checkouts made by hcoord (`ensureWorktree`, `src/git.ts:79-95`) are filtered out of the sidebar (`src/board.ts:95-97`). Their tasks show quickly anyway, because task state lives in `tasks.json` under the watched folder.

### 5. Measured cost of a refresh

Measured on this machine (2 projects, 3 checkouts, 5 tasks):

| What | Time |
|---|---|
| `board()` in-process | ~43 ms |
| `bun src/cli.ts board --json` | ~60 ms |
| through the `~/.local/bin/hcoord` sh shim, in this agent's sandbox | ~580 ms (`sh -c 'exit 0'` alone took ~260 ms here, so most of that is the sandbox's process start-up, not hcoord) |

A refresh is cheap, so refreshing more often or on more triggers is affordable. The delay comes entirely from when a refresh is triggered, not from what it costs.

## Root causes

1. **No trigger for git-side changes.** The only watch is `~/.herdr-coordinator/projects` (`main.js:136-151`). New worktrees and branch switches change `<repo>/.git`, so they're picked up only by the 30 s fallback (`main.js:25`, `:97`). Worst case about 30 s, average about 15 s.
2. **Herdr's space events are ignored as a refresh signal.** A new space whose folder is in a known project's repo but not in any known checkout is exactly the "new worktree" signal. `lookAtNewSpaces` even computes that (`main.js:364-371`), then drops it instead of refreshing.
3. **`followSpace` decides once, on stale data.** It records the focused space before it knows the worktree (`main.js:289` then `:294`), so the coordinator isn't auto-started for a worktree made with the `+` dialog. Not a refresh delay as such, but it's the visible half of the same problem.

## Fix options, ranked by impact ÷ effort

1. **Refresh when a new space lands in a known repo but no known checkout** (high impact, tiny effort). In `lookAtNewSpaces`, where the repo is already a project (`main.js:371`), call `this.refresh(cx)` instead of returning. Rows for the `+` dialog and for any space opened on a new worktree would show in about 2 s (the settle delay at `:360`) instead of up to 30 s. A cheaper variant is to call `refresh()` from `render()` whenever the set of space ids changes. That runs one extra board per space created or closed.
2. **Re-run `followSpace` after each refresh** (high impact for the `+` flow, small effort). For example, clear `this.space` when `worktreeAt` returned null at `main.js:294`, or keep a `pendingSpace` and check it at the end of `refresh()`. Together with fix 1, the `+` dialog would start the worktree's coordinator by itself, as `docs/design-worktrees.md:72` intends.
3. **Shorten `FALLBACK_MS`** (medium impact, trivial effort). A board run is about 50 ms and a few git calls per project, so 5 to 10 s is affordable. It cuts the worst case for terminal-made worktrees and branch switches (case c) from 30 s to 5 to 10 s. It costs one short `bun` + git run every few seconds while Herdr is open. The coordinator's log pane uses the same constant (`main.js:756`), so give the sidebar its own interval.
4. **Watch each project's `<git-common-dir>/worktrees` folder** (high impact for case c, medium effort). Spawn one `watchFolder` per project repo, like `watch()` at `main.js:136-151`, and refresh on the result. That catches `git worktree add/remove` at once. There are two catches:
   - Worker checkouts also live in `.git/worktrees/<id>/`, and every worker commit or `git status` touches their `index` / `logs`. Filter the changed paths to a new or removed `worktrees/<name>` folder and `worktrees/<name>/HEAD`, and debounce (for example 300 ms).
   - Branch switches in the **main** checkout write `.git/HEAD`, which needs a watch on `.git` itself. That folder is noisy (`objects/`, `index`), so filter to `HEAD` only, or leave the main checkout to the fallback timer.

   The watch list must follow `this.data.projects` as projects come and go.
5. **Refresh when Herdr's New worktree dialog closes** (medium impact, small effort, depends on an API). If `openOverlay` resolves or signals when the dialog closes, `newWorktree()` (`main.js:301-305`) could `refresh()` right then. Fix 1 already covers this without needing that API, so it's optional.
6. **Make hcoord record outside-made worktrees under `projects/`** (low value). For example, a periodic `hcoord sync` could register new checkouts, so the existing watch fires. That just moves the polling somewhere else. Not recommended.

Recommended: 1 + 2 together, about ten lines in `main.js`. They fix the common `+` flow completely, including the coordinator auto-start. Add 3 as a cheap cap on the worst case for terminal-made worktrees, and do 4 only if near-instant pickup of `git worktree add` from a terminal matters.
