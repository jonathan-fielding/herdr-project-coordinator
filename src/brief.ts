import type { Task } from "./model.ts";
import type { ProjectMeta } from "./store.ts";

export interface BriefInput {
  meta: ProjectMeta;
  task: Task;
  worktree: string;
  /** Coordinator terminal address, if any. */
  coordinator: string | null;
  /** PROJECT.md (standing instructions: how to test, conventions). */
  projectNotes?: string;
}

/** The worker's first and only prompt. Everything it needs is here; nobody watches its terminal. */
export function renderWorkerBrief({ meta, task, worktree, coordinator, projectNotes }: BriefInput): string {
  const id = task.id;
  const notes = projectNotes?.trim();
  return `You are a worker agent on project "${meta.name}", started by hcoord for one task.
No person is watching this terminal: a coordinator agent reads your report and talks to the person.

Task: ${id} ${task.title}
Worktree: ${worktree}
Branch: ${task.branch}
Base repo: ${task.repo}
Coordinator terminal: ${coordinator ?? "(none)"}

## The task

${task.brief.trim()}
${notes ? `\n## Project notes (from PROJECT.md)\n\n${notes}\n` : ""}
## Rules

- Work only inside your worktree (${worktree}). Commit your work to ${task.branch} as you go.
  Do not push, merge, rebase onto other branches, switch branches, or delete branches.
- Change only the files and areas the task gives you. Other workers own the rest.
- Do not start other agents or subagents. The only hcoord command you run is \`hcoord report\`.
- Don't ask questions in plain text and stop: nobody will see them. Use a needs_you report (below).

## Reporting back (required)

When you have finished and committed, report with a short markdown report: what changed,
how you tested it, and open questions. Pass it on stdin:

    hcoord report ${id} --state done --file - <<'REPORT'
    One sentence saying what you did.

    ...details...
    REPORT

The first line becomes the one-line summary the person sees, so make it a sentence.
hcoord records the report and tells the coordinator. Then stop.

If you are blocked on a decision you can't reasonably make yourself, report the question,
then stop. The answer will arrive as a message in this terminal; carry on from there and
report again when done:

    hcoord report ${id} --state needs_you --file - <<'REPORT'
    The question, in one sentence.

    The options you see, and which you'd pick.
    REPORT

If you can't finish the task at all, report with --state failed and say why in the first line.
`;
}
