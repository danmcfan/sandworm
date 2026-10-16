# Context

You work in the {{REPO}} repo on branch `{{TARGET_BRANCH}}`, for issue #{{ISSUE_NUMBER}}. Read `AGENTS.md` first and obey it.

The branch must take in `{{UPSTREAM}}`, which has moved on since the branch was cut from it or last merged it: main, or the open pull request this branch is stacked on. Its pull request will conflict until it does, and GitHub runs no CI on a conflicting pull request.

!`git log --oneline {{UPSTREAM}}..HEAD`

# Task

1. Run `git merge {{UPSTREAM}}` (a merge, not a rebase: the branch may already be pushed).
2. Resolve each conflict by hand so that the branch keeps both what `{{UPSTREAM}}` changed and what this issue changed. Read its commits that touched the file (`git log {{UPSTREAM}} -- <file>`) to see why it changed. A generated or binary file: take its version, then regenerate it from the merged code.
3. Commit the merge. Keep git's default merge message and list the resolved files under it.
4. `bun run check` must pass. Fix any failure the merge caused, in a commit of its own.

Do not change what this issue built beyond what the merge needs. Do not push, open a PR or merge the PR.

# Done

When the merge is committed and `bun run check` passes, output <promise>COMPLETE</promise>.
