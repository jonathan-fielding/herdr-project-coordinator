import type { Task } from "./model.ts";
import type { ProjectMeta } from "./store.ts";

export interface BriefInput {
  meta: ProjectMeta;
  task: Task;
  worktree: string;
  /** Coordinator terminal address, if any. */
  coordinator: string | null;
}

/** The first (and only) prompt a worker gets. Phase 3 may refine the wording; the contract is the commands. */
export function renderWorkerBrief({ meta, task, worktree, coordinator }: BriefInput): string {
  const id = task.id;
  return `You are a worker agent on project "${meta.name}", started by hcoord for one task.

Task: ${id} ${task.title}
Worktree: ${worktree}
Branch: ${task.branch}
Base repo: ${task.repo}
Coordinator terminal: ${coordinator ?? "(none)"}

## The task

${task.brief.trim()}

## Rules

- Work only inside your worktree (${worktree}). Commit your work to ${task.branch}.
  Do not push, merge, rebase onto other branches, or switch branches.
- Stay inside the files and areas the task gives you. Other workers own the rest.
- Do not start other agents or subagents.

## Reporting back (required)

When you have finished, report with a short markdown report (what changed, how you tested
it, open questions). Pass it on stdin:

    hcoord report ${id} --state done --file - <<'REPORT'
    ...your report...
    REPORT

The first line of the report becomes its one-line summary, so make it a sentence.
hcoord records it and notifies the coordinator for you. Then stop.

If you are blocked on a decision only a person can make, report the question instead,
then stop and wait. The answer will arrive as a message in this terminal:

    hcoord report ${id} --state needs_you --file - <<'REPORT'
    ...the question, with the options you see...
    REPORT

If you cannot finish the task at all, report with --state failed and say why.
`;
}
