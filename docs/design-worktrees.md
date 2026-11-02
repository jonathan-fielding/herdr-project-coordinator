# Worktree model (replaces "one coordinator per project")

Agreed 2026-11-02:

- Project = one repo.
- Workers get their own sub-worktrees, merged back into their worktree's branch.
- Worktrees are Herdr's worktree spaces.
- The main checkout gets a coordinator too.
- Logs are readable transcripts.

```
Project (one repo)                  ~/.herdr-coordinator/projects/<slug>/project.json
 ├─ worktree "root" (main checkout) ← coordinator coord-<prefix>-root
 ├─ worktree "feature-login"        ← coordinator coord-<prefix>-feature-login
 │    ├─ worker SHP-3  branch coord/feature-login/shp-3-…  off feature-login, merged back
 │    └─ worker SHP-4  …
 └─ …
```

## Worktrees ("lanes" in the code)

- A worktree is a checkout of the project's repo: the main one, or any linked worktree.
  - In Herdr that is a space whose folder is that checkout. Herdr's New worktree makes them under `~/.herdr/worktrees/<repo>/<branch>`.
  - hcoord's own worker checkouts under `worktreeRoot` are never worktrees in this sense.
- Each worktree has a key: `root` for the main checkout, otherwise the slug of its branch at the time it was registered.
  - project.json holds them: `lanes: { [key]: { path, branch, coordinator? } }`.
  - It's registered the first time it's opened (`hcoord lane open <path>`).
- Its coordinator:
  - It runs in the worktree folder, so trust follows the repo. Worktrees inherit their main checkout's trust.
  - It carries `HCOORD_PROJECT` and `HCOORD_LANE`, so `hcoord task add/list` act on its own worktree's tasks.
  - It's started with `--session-id`. The session is saved, so recovery can `--resume` it.

## Tasks

- A project's tasks stay in one tasks.json with one id sequence (SHP-n). Each task has `lane`.
- A worker's branch is `coord/<lane>/<id>-<slug>`, made from the worktree's HEAD at start.
  - Its checkout is under `worktreeRoot/<project>/<id>`, as before.
- **Merging back.** On a done report, hcoord merges the worker's branch into the worktree's branch, in the worktree (`git merge --no-ff --no-edit`).
  - Success makes the task `merged`.
  - A conflict, or local changes in the way: the merge is aborted. The task stays `done` with `mergeError`, and the coordinator is told.
  - `hcoord task merge <id>` tries again.
  - Branches are never deleted or pushed.
  - This deliberately overrides the plan's "never merge" for these local merges only.
- `task clean` checks that the branch is merged into the worktree's branch, not into the main checkout.

## Logs

- Every Claude agent hcoord starts gets `--session-id <uuid>`, stored on the task (`session`) or on the worktree's coordinator.
- `hcoord log <task id | lane>` renders the transcript (`~/.claude/projects/*/<uuid>.jsonl`) as markdown:
  - the agent's text;
  - each tool call (command, file edited) with a short result;
  - hcoord's reports.
- The Projects section opens it in a Herdr pane that follows the transcript as it grows.

## Herdr Projects section

```
PROJECTS                                   +
▾ shop                                     2 ⚠
    root · main                          ○
    feature-login                        ⟳   +
      Needs you  ! SHP-3 Users API …
      Working    ⟳ SHP-4 Users page      ≡ (log)
```

- **A project row** shows the project. Its `+` opens Herdr's New worktree dialog for the repo.
- **A worktree row** shows the worktree's branch and its coordinator.
  - Click: go to its space and coordinator. The coordinator is started there if it's not running.
- **A task row:**
  - Click: peek at the live worker.
  - Log icon (or click once the worker has ended): its transcript.
- **Going to a project's worktree space** starts that worktree's coordinator, at most once a minute.
