# Context

You work in the {{REPO}} repo. Read `AGENTS.md` first and obey it, and the docs it points to.

Your issue:

!`gh issue view {{ISSUE_NUMBER}} --comments`

# Task

You are on branch `{{TARGET_BRANCH}}`, with dependencies installed.

1. Build issue #{{ISSUE_NUMBER}}. Use the `/tdd` skill: work test-first wherever the code has a seam a test can drive.
2. Commit as you go, in the style of `git log`. A commit subject names no issue but #{{ISSUE_NUMBER}}, even when you build on another issue's branch.
3. {{VERIFY}}
4. `bun run check` must pass before you stop.

Build only on this branch. Never `git reset`, rebase, or merge another branch into it. If the issue depends on another issue's unmerged PR, this branch was cut from that PR's branch, so the work is already here: build on it, and diff against `{{BASE}}` to see only this issue's changes. Only if the issue needs work that is on no branch you have (nothing in `git log` provides it), make no changes: write what is missing and where it lives to `out/pipeline/blocked.md`, and stop.

The issue's labels (the `labels:` line above) say who makes the calls it leaves open, such as design, art or placement:

- `ready-for-agent`: you do. Make each call yourself, in line with the repo's docs, and name it in your commit message so the PR can list it. Do not stop to ask.
- Any other label (`ready-for-human`, `needs-owner`) or none: the owner does. If the issue leaves such a question open, make no changes: post the question as a comment on the issue with `gh issue comment {{ISSUE_NUMBER}}`, write it to `out/pipeline/blocked.md`, and stop.

Another agent reviews your work after you, so do not review it yourself. Do not push, open a PR or merge.

# Done

When `bun run check` passes and the work is committed, or `out/pipeline/blocked.md` is written, output <promise>COMPLETE</promise>.
