# Context

You review the work on branch `{{TARGET_BRANCH}}` for issue #{{ISSUE_NUMBER}}. Another agent wrote it. You change no code and make no commits.

Commits under review:

!`git log --oneline {{BASE}}..HEAD`

# Task

1. Use the `/code-review` skill with fixed point `{{BASE}}`. The spec is issue #{{ISSUE_NUMBER}}: read it with `gh issue view {{ISSUE_NUMBER}} --comments`. Do not ask the user anything; nobody is there to answer. If `out/pipeline/feedback.md` exists, the PR is already open and this round answers the owner's comments in it: they are part of the spec too, and any comment the branch does not yet answer is a **must fix** Spec finding.
2. A decision the issue left to the owner (design, art, placement) that the code makes anyway is a **must fix** Spec finding. Before approving a new shared module, search the repo for an existing module with the same job; a second copy is a **must fix** finding.
3. On the Standards axis, also use the `/codebase-design` skill's vocabulary: flag shallow modules, leaky seams and interfaces that could be deeper.
4. Decide what happens to each finding. A cheaper agent applies the fixes and follows your verdicts, so commit to one per finding; do not hedge with "judgement call":
   - **must fix**: a bug, a spec gap, or a finding that undercuts what the issue is for.
   - **should fix**: worth the change in this PR.
   - **won't fix: <reason>**: wrong, not worth the change, or belongs to another issue (name it).
     On a Spec finding, won't fix is allowed only when the finding is wrong (`won't fix: wrong, <why>`) or belongs to an issue you name as `#N`; check that it exists with `gh issue view N`, or file it with `gh issue create`. The run will not publish otherwise.
5. Write the report to `out/pipeline/review.md`, with the `## Standards` and `## Spec` headings from the skill. Number every finding (S1, S2, … and P1, P2, …), and give each its verdict, file, line and a one-line fix. Start anything that needs the owner to decide with `Owner decision:`. If there are no findings, write `No findings.` as the whole file.

# Done

When `out/pipeline/review.md` is written, output <promise>COMPLETE</promise>.
