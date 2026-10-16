# Context

You work in the {{REPO}} repo on branch `{{TARGET_BRANCH}}`, for issue #{{ISSUE_NUMBER}}. Read `AGENTS.md` first and obey it.

The branch's work is done but not pushed. It must move onto `{{ONTO}}`: another open pull request it conflicts with or builds on, or main once that pull request has merged. `git rebase --onto {{ONTO}} {{UPSTREAM}}` conflicts, so the host left it to you.

The commits to move:

!`git log --oneline {{UPSTREAM}}..HEAD`

# Task

1. Run `git rebase --onto {{ONTO}} {{UPSTREAM}}`. Rebasing is right here: nothing is pushed yet, or the host force-pushes after you.
2. Resolve each conflict by hand so that the result keeps both what `{{ONTO}}` holds and what this issue changed. Read its commits that touched the file (`git log {{ONTO}} -- <file>`) to see why it changed. A generated or binary file: take its version, then regenerate it from the rebased code. Then `git rebase --continue`, until the rebase is done.
3. `bun run check` must pass. Fix any failure the rebase caused, in a commit of its own.

Do not change what this issue built beyond what the rebase needs. Never `git rebase --abort` or `git reset` away the issue's commits. Do not push, open a PR or merge.

# Done

When the rebase is finished and `bun run check` passes, output <promise>COMPLETE</promise>.
