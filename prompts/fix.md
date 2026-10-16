# Context

You work in the {{REPO}} repo on branch `{{TARGET_BRANCH}}`, for issue #{{ISSUE_NUMBER}}. Read `AGENTS.md` first and obey it.

{{TASK}}

# Task

1. Handle each item above. Fix every item marked **must fix** or **should fix**, and leave items marked **won't fix** alone. Skip an item only when the fix proves wrong in the code (it breaks something, or rests on a false premise) and say what you found; "not worth the change" is not a reason to skip, because the reviewer already weighed that. An item with no verdict counts as must fix.
2. Commit as you go, in the style of `git log`. {{REVERIFY}}
3. Append what you did to `out/pipeline/fixes.md`: one line per item, `<id>: fixed | skipped | won't fix: <reason>`.
4. `bun run check` must pass before you stop.

Do not push, open a PR or merge.

# Done

When `bun run check` passes and the work is committed, output <promise>COMPLETE</promise>.
