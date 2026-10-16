# 1. Rebase a branch before it is pushed, merge into it after

Date: 2026-10-16

## Status

Accepted

## Context

A stacked branch (see GLOSSARY.md) has to move when the PR under it changes: a conflict found
after the work is done, a parent that merges into main, or a parent that gets new commits.

Git offers two ways to move it. A rebase rewrites the branch's commits, which keeps its PR's diff
clean but breaks anyone holding the old commits: the owner's review comments on them, and their
own pushes to the PR. A merge keeps history but, once a parent is squash-merged, conflicts with
the parent's own commits that the branch still holds.

We also considered predicting conflicts before implementing, from the files an issue says it
touches. That is unreliable: issues rarely name files, and agents touch files nobody predicted.

## Decision

- **Before the branch is pushed**, rebase freely. The stack step runs after the check, when the
  touched files are known, and moves the branch onto a conflicting open PR with
  `git rebase --onto <PR head> <old base>`, then runs the check again.
- **After the branch is pushed**, merge the parent's new commits into it (`sync.md`), as the owner
  may hold the commits and have review comments on them.
- **The one exception**: once the parent has merged (squash), rebase the branch's own commits onto
  main with `git rebase --onto origin/main <parent sha>`, push with `--force-with-lease`, and
  retarget the PR to main. Merging main in would conflict with the parent's squashed copy.

When git can do it cleanly, the host does; an agent (`stack.md` or `sync.md`) resolves conflicts.

## Consequences

- Conflicts are only found once the work is done, so an agent may build something it then has
  to rebase. That costs less than wrong predictions.
- A stacked PR is force-pushed once, when its parent merges. The owner should expect that.
