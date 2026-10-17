# Context

The work on branch `{{TARGET_BRANCH}}` for issue #{{ISSUE_NUMBER}} is done. Your job is to write its pull request. The host opens the PR; you only write files. You change no code and make no commits. Do not create, comment on or edit GitHub issues.

Commits:

!`git log --oneline {{BASE}}..HEAD`

# Task

1. Read the issue (`gh issue view {{ISSUE_NUMBER}}`), the diff (`git diff {{BASE}}...HEAD`), `out/pipeline/review.md` and `out/pipeline/fixes.md` (if it exists).
2. Look at the screenshots and videos under `{{EVIDENCE}}/`, if there are any. Pick the few that best show the change; open each image to check it shows what you claim.
   If `out/pipeline/feedback.md` exists, the PR is already open and this round answered the owner's comments in it. Read the current title and body (`gh pr view {{TARGET_BRANCH}} --json title,body`) and rewrite them so they describe the branch as it now stands, not as it was. Keep earlier rounds' review results, and add a `## Feedback` section: each comment and what changed for it. The host replaces the title and body with yours.
3. Use the `/pr` skill to write the body to `out/pipeline/pr-body.md`. Add:
   - `Closes #{{ISSUE_NUMBER}}` near the top.
   - A `## Calls made` section, if the commits record calls the agent made that the issue left open (design, art, placement): each one and what was chosen.
   - A `## Review` section: each finding the review fixed, from `review.md`, and each item fixed after it, from `fixes.md`.
   - A `## Out of scope` section, if any finding is **won't fix**: each one with its reason, and the `#N` the review named, if any.
   - A `## Skipped` section, if the review or a later fix skipped any finding: each one with what it found.
   - Last line: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
     Reference each picked file by its path from the repo root: `![what it shows](./{{EVIDENCE}}/<path>)`.
     Confirm every claim about the code with a search (`git grep`, `git diff`) before writing it.
4. Write `out/pipeline/pr.json`: `{"title": "...", "attach": ["{{EVIDENCE}}/<path>", ...]}`. The title follows `git log` style (`Area: what changed`). `attach` lists every file the body references, and each must exist.

# Done

When both files are written, output <promise>COMPLETE</promise>.
