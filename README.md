# sandworm

The [Sandcastle](https://github.com/ai-hero/sandcastle) pipeline shared by danmcfan's repos: one issue in, one PR out.

```
feedback → setup → implement (Opus) → review (Opus) → fix (Sonnet) → check, refixing up to 3× → stack → PR body (Sonnet) → gate → publish
```

A repo runs it with `bun run sandcastle [issue] [--fresh]`, or over many issues with
`bun run sandcastle:batch [12 10-20 …] [--workers N] [--fresh]`. Rerunning an issue carries on
where it stopped; rerunning it once its PR is open answers the owner's new PR comments.

## Using it in a repo

```sh
bun add -d github:danmcfan/sandworm#v0.1.0
```

`.sandcastle/config.ts` says what is particular to the repo:

```ts
import { defineConfig } from "sandworm";

export default defineConfig({
  repo: "arcade",
  // branch: (issue) => `agent/${issue}`,   // the default
  // base: "HEAD",                          // or "origin/main", fetched first
  // keep: ["out"],                         // gitignored dirs kept between runs
  prompts: {
    verify: "For any change the player can see or hear, write and run a verify check (…).",
    reverify: "If a fix changes what the player sees or hears, rerun the verify check for it.",
    evidence: "out/verify",
  },
  batch: { workers: 2, mergeBugs: true }, // skipLabels: ["needs-owner"], the default
  // stack: { blockers: true, conflicts: true },   // the default; false for either turns it off
});
```

with two entry points:

```ts
// .sandcastle/main.ts
import { runSingle } from "sandworm";
import config from "./config.ts";
await runSingle(config);
```

```ts
// .sandcastle/batch.ts
import { runBatch } from "sandworm";
import config from "./config.ts";
await runBatch(config);
```

and `"sandcastle": "bun .sandcastle/main.ts"`, `"sandcastle:batch": "bun .sandcastle/batch.ts"` in `package.json`.
The repo keeps its own `Dockerfile`, `.env` (from `.env.example`) and `.gitignore` (`.env`, `logs/`, `worktrees/`) in `.sandcastle/`.

### Stacked PRs

An issue can build on another issue's PR before the owner merges it (the words are in
[GLOSSARY.md](GLOSSARY.md)):

- **Blocked-by links.** If GitHub says issue B is blocked by issue A (its native issue
  dependencies, not text in the body) and A has an open PR, B's branch is cut from A's branch and
  B's PR targets it, with "Stacked on #PR (issue #A). Merge that first." at the top of its body.
  Several blockers must be on one chain; B stacks on the tip. A blocker with no PR skips B, saying
  why. A batch runs blockers first and starts B once A has published.
- **Conflicts.** After the check, the stack step trial-merges the branch against every open PR.
  If it conflicts, the branch is rebased onto that PR (onto the one with the most conflicting files
  when several unrelated PRs conflict; the PR body names the others) and the check runs again.
- **Restacking.** Rerunning a stacked issue rebases it onto main once its parent has merged and
  retargets the PR to main, or merges in the parent's new commits if it has moved on.

Under `mergeBugs`, a bug never stacks: it is cut from origin/main, its PR targets main, and no
other branch stacks on it by conflict. `stack: { blockers: false, conflicts: false }` turns it all off.
Why branches are rebased before the push and merged after is in [ADR 0001](docs/adr/0001-rebase-before-push-merge-after.md).

### Prompts

The prompts are in [`prompts/`](prompts). A repo overrides one by putting a file of the same
name in `.sandcastle/`. Every prompt can use `{{REPO}}`, `{{BASE}}` (what to diff against),
`{{VERIFY}}`, `{{REVERIFY}}`, `{{EVIDENCE}}`, `{{ISSUE_NUMBER}}` and Sandcastle's `{{TARGET_BRANCH}}`;
`fix.md` also gets `{{TASK}}` and `pr.md` gets `{{CHECK}}`. On a stacked branch `{{BASE}}` is the
parent's branch (`origin/<branch>`), so review, fixes and the PR body see only this issue's diff.
`sync.md` gets `{{UPSTREAM}}`, the ref to merge in (origin/main, or the parent's branch).
`stack.md` gets `{{ONTO}}` and `{{UPSTREAM}}`: it resolves a `git rebase --onto` that conflicted.

A blocked issue's branch already holds its blocker's work, so the implement agent builds on it.
It stops by writing `out/pipeline/blocked.md` only when the issue needs work on no branch it has;
the run then fails with its reason.

## When a run fails

The gate checks the run's outputs before publish: each won't-fix Spec finding names an issue that
exists (or says the finding is wrong), each `## Follow-ups` entry links an issue, every evidence path
in the PR body is on disk and in `pr.json`'s `attach`, and no commit subject names another issue.
A failure opens no PR; the failures are in `out/pipeline/gate.md` and `error.log`, and a rerun
restarts at fix with them as its task.

Each issue's logs are in `.sandcastle/logs/<issue>/`: one log per agent session, `state.json`
(the steps done, and under `failed` the step and error that ended the last run), and
`error.log`, which has every failure and stop with its stack and any failed command's stderr.
A failure is also noted at the end of the agent log that was running. A closed terminal
(SIGHUP), an uncaught error and an early exit are recorded there too.

## Working on sandworm

Changes reach a repo only when it moves to a new tag. To try a change before releasing it:

```sh
cd ~/code/sandworm && bun link
cd ~/code/arcade && bun link sandworm     # undo with: bun add -d github:danmcfan/sandworm#v<x>
```

Release from a clean `main` with `bun run release patch|minor|major`, which runs the check,
tags and pushes, then update each repo with `bun add -d github:danmcfan/sandworm#v<version>`.
