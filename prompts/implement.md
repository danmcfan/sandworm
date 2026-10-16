# Context

You work in the {{REPO}} repo. Read `AGENTS.md` first and obey it, and the docs it points to.

Your issue:

!`gh issue view {{ISSUE_NUMBER}} --comments`

# Task

You are on branch `{{TARGET_BRANCH}}`, with dependencies installed.

1. Build issue #{{ISSUE_NUMBER}}. Use the `/tdd` skill: work test-first wherever the code has a seam a test can drive.
2. Commit as you go, in the style of `git log`.
3. {{VERIFY}}
4. `bun run check` must pass before you stop.

Build only on this branch. Never `git reset`, rebase, or merge another branch into it. If the issue needs work that is not on this branch yet (a dependency still on another agent's branch or an unmerged PR), make no changes: write what is missing and where it lives to `out/pipeline/blocked.md`, and stop.

Decisions the issue leaves to the owner (design, art, placement) are theirs, not yours. If the issue leaves such a question open, make no changes: post the question as a comment on the issue with `gh issue comment {{ISSUE_NUMBER}}`, write it to `out/pipeline/blocked.md`, and stop.

Another agent reviews your work after you, so do not review it yourself. Do not push, open a PR or merge.

# Done

When `bun run check` passes and the work is committed, or `out/pipeline/blocked.md` is written, output <promise>COMPLETE</promise>.
