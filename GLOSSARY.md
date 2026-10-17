# Glossary

**Issue run**: one issue through the pipeline, from feedback to publish, on one branch
(`config.branch(issue)`) in one container. Its progress is `.sandcastle/logs/<issue>/state.json`.

**Blocker**: an issue that blocks another: through GitHub's native issue dependencies ("blocked by"),
or named on a line of the issue's body that opens with "Blocked by #N". Owners write both.

**Parent**: the open PR a branch is built on instead of main, recorded as
`{ issue, branch, pr, sha }` in state.json. `sha` is the parent's tip when the branch was cut
from it or last took in its commits. A branch has at most one parent. Once a parent merges, its
issue is kept in state.json's `pastParents`, so the gate still lets the branch's commits name it.

**Stack** (verb): build a branch on a parent. The branch is cut from (or rebased onto) the
parent's branch, its prompts diff against it (`{{BASE}}`), and its PR targets it. A branch is
stacked on its blocker's PR, or on an open PR it conflicts with. _Avoid_: "depend on", which means
the blocked-by link, not the branch.

**Chain**: open PRs each stacked on the one before. Several parents are allowed only as a chain,
and the branch stacks on its tip, which holds them all.

**Restack**: move a stacked branch as its parent changes, on a rerun. Once the parent merges,
the branch's own commits are rebased onto main and its PR retargeted to main; while the parent is
open and has new commits, they are merged in. See ADR 0001 for why one rebases and one merges.

**Exempt bug**: under `batch.mergeBugs`, an issue labelled `bug`. It is cut from origin/main,
never stacks, and no branch stacks on it by conflict, because it is merged into main on its own.

**Publish**: push the branch and open (or update) its PR. A batch issue waiting on a blocker
starts once the blocker has published, not once it has merged.
