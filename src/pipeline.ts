import { claudeCode, createSandbox, type SandboxRunResult } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { $ } from "bun";
import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { argsFor, promptPath, type Resolved } from "./config.ts";
import { gate, report, rewind, type RunArtefacts } from "./gate.ts";
import { describe, journal } from "./journal.ts";
import {
  conflictTarget,
  findParent,
  isParent,
  mergeIn,
  rebaseOnto,
  Skip,
  stackNote,
  tipOf,
  withoutStackNote,
  type Parent,
} from "./stack.ts";
import type { Tui } from "./tui.ts";

// The pipeline for one issue, shared by the single-issue and batch runners.
//
// One container, one branch (config.branch, cut from config.base):
//   implement (Opus) → review, which fixes its findings (Opus) → check, refixing up to 3 times
//   → stack → PR body (Sonnet) → gate (src/gate.ts), back to fix (Sonnet) once if it fails
// then it pushes the branch and opens the PR. It is a draft if the check is still red.
//
// A branch is stacked (see GLOSSARY.md and src/stack.ts) when its issue is blocked by another
// issue with an open PR: it is cut from that PR's branch, the prompts diff against it, and the PR
// targets it. The stack step moves a branch that conflicts with an open PR onto that PR, before
// anything is pushed. A rerun restacks: onto main once the parent has merged, or merging in the
// parent's new commits. Bugs under mergeBugs (run.bug) never stack.
// A branch with no commits (an audit with nothing to change) gets the PR body as an issue comment instead.
// Each agent's full output goes to .sandcastle/logs/<issue>/, and every failure or stop to its error.log.
//
// Running the same issue again skips the steps an earlier run finished (kept in
// .sandcastle/logs/<issue>/state.json) and starts the stopped step over on the same branch.
// A gate failure is the exception: the run goes back to fix once, with out/pipeline/gate.md as the
// task, and if the gate fails again its rerun starts at fix the same way.
// `fresh` forgets those and starts from implement; the branch keeps its commits.
//
// Running it again once the PR is open starts a feedback round if the owner (the `gh` user) has
// commented on the PR since the last round: their comments go to out/pipeline/feedback.md and
// implement (address.md) → review → fix → check → PR body run again, then publish pushes and
// rewrites the PR's title and body. With no new comments the run does nothing.
const MAX_FIX_ROUNDS = 3;
const MAX_GATE_ATTEMPTS = 2;
const OPUS = claudeCode("claude-opus-5-5", { effort: "low" });
const SONNET = claudeCode("claude-sonnet-5-5", { effort: "low" });

export const STEPS = [
  "feedback",
  "setup",
  "implement",
  "review",
  "fix",
  "check",
  "stack",
  "pr",
  "gate",
  "publish",
] as const;

/** The parts of the progress view the pipeline drives. */
export type Reporter = Omit<Tui, "close">;

export interface Progress {
  done: string[];
  green?: boolean;
  url?: string;
  // publish found no commits and commented on the issue instead of opening a PR
  commented?: boolean;
  /** Feedback rounds run so far. */
  rounds?: number;
  /** When the newest owner comment a feedback round took in was made, as ISO 8601. */
  feedbackSeen?: string;
  /** The open PR this branch is stacked on, if any; kept across --fresh and feedback rounds. */
  parent?: Parent;
  /** Issues of earlier parents that merged, newest last; their commits may still name them. Kept like `parent`. */
  pastParents?: string[];
  /** Open PRs the branch also conflicts with but could not stack on too, by number. */
  alsoConflicts?: string[];
  /** The gate failed, so fix works from out/pipeline/gate.md. */
  gated?: boolean;
  /** How the last run ended, if it did not finish; error.log has the whole story. */
  failed?: { step: string; at: string; error: string };
}

export interface IssueRun {
  config: Resolved;
  issue: string;
  /** Ref a new branch is cut from, overriding config.base. */
  base?: string;
  /** A bug under mergeBugs: cut from `base`, never stacked, and its PR always targets main. */
  bug?: boolean;
  fresh?: boolean;
  reporter: Reporter;
  /** Aborting it stops the agent and removes the container; runIssue then rejects with its reason. */
  signal: AbortSignal;
  /** Every agent session run, for the usage report. */
  runs: { step: string; result: SandboxRunResult }[];
  /** Runs container setup in turn with other runs' setups, for callers that run issues in parallel. */
  serialize?: <T>(work: () => Promise<T>) => Promise<T>;
  /** Called with the step about to run, so a caller can say where a run stopped. */
  onStep?: (step: string) => void;
}

export const logsFor = (issue: string): string => `.sandcastle/logs/${issue}`;

export async function runIssue(run: IssueRun): Promise<Progress> {
  const logs = logsFor(run.issue);
  const stateFile = `${logs}/state.json`;
  let step = "feedback";
  // The agent log being written, so a failure is noted at the end of it as well.
  let agentLog: string | undefined;
  const tracked: IssueRun = {
    ...run,
    onStep: (name) => {
      step = name;
      agentLog = undefined;
      run.onStep?.(name);
    },
  };
  try {
    return await pipeline(tracked, (log) => {
      agentLog = log;
    });
  } catch (error) {
    const skipped = error instanceof Skip;
    const what = run.signal.aborted
      ? `stopped: ${describe(run.signal.reason)}`
      : skipped
        ? `skipped: ${error.message}`
        : "failed";
    journal(logs, step, what, run.signal.aborted || skipped ? undefined : error, agentLog);
    const stored: unknown = existsSync(stateFile) ? await Bun.file(stateFile).json() : undefined;
    const progress: Progress = isProgress(stored) ? stored : { done: [] };
    const failed = { step, at: new Date().toISOString(), error: run.signal.aborted ? what : describe(error) };
    await Bun.write(stateFile, JSON.stringify({ ...progress, failed }, null, 2));
    throw error;
  }
}

async function pipeline(run: IssueRun, writing: (log: string) => void): Promise<Progress> {
  const { config, issue, reporter: tui, signal, runs } = run;
  const base = run.base ?? config.base;
  const branch = config.branch(issue);
  const logs = logsFor(issue);
  // Sandcastle removes a clean worktree when the run ends, and the kept directories are
  // gitignored, so they are saved here between runs and put back on the next one.
  const saved = (dir: string): string => `${logs}/${dir}`;
  const savedOut = saved("out");
  const stateFile = `${logs}/state.json`;

  if (run.fresh === true) for (const dir of config.keep) rmSync(saved(dir), { recursive: true, force: true });
  const stored: unknown = existsSync(stateFile) ? await Bun.file(stateFile).json() : undefined;
  let progress: Progress = isProgress(stored) ? stored : { done: [] };
  // --fresh starts the steps over on the same branch, which is still stacked where it was.
  if (run.fresh === true) progress = { done: [], ...stacking(progress) };
  if (run.bug === true) delete progress.parent;
  delete progress.failed;
  const save = async (): Promise<void> => {
    await Bun.write(stateFile, JSON.stringify(progress, null, 2));
  };
  // What the branch's own work is measured from: its parent's branch if it is stacked.
  const stackedOn = (): string | undefined =>
    progress.parent === undefined ? undefined : `origin/${progress.parent.branch}`;

  const enter = (name: string): void => {
    run.onStep?.(name);
  };

  // A published PR with new owner comments starts a feedback round: every step after setup runs again.
  // With none, the run has nothing to do unless the PR is stacked and may need restacking.
  enter("feedback");
  const feedback = await newFeedback(progress, signal);
  const restackOnly = feedback?.comments === "";
  if (feedback === null)
    tui.skip("feedback", progress.url === undefined ? "no PR yet" : "no open PR, or a round to carry on");
  else if (feedback.comments === "") {
    tui.done("feedback", "no new comments");
    if (progress.parent === undefined) return progress;
  } else {
    const rounds = (progress.rounds ?? 0) + 1;
    progress = {
      done: [],
      rounds,
      ...(progress.url === undefined ? {} : { url: progress.url }),
      ...(feedback.seen === undefined ? {} : { feedbackSeen: feedback.seen }),
      ...stacking(progress),
    };
    // The last round's review and fixes would read as this round's.
    for (const file of ["review.md", "fixes.md", "check.log"]) rmSync(`${savedOut}/pipeline/${file}`, { force: true });
    await Bun.write(`${savedOut}/pipeline/feedback.md`, feedback.comments);
    await Bun.write(`${logs}/feedback-${rounds}.md`, feedback.comments);
    tui.done("feedback", `round ${rounds}: ${feedback.count} comment(s)`);
  }
  // The local branch may lag the pushed one (the owner can push to the PR too).
  if (feedback !== null) await catchUp(branch);
  const answering = progress.rounds !== undefined && existsSync(`${savedOut}/pipeline/feedback.md`);

  enter("setup");
  // A new branch is cut from the open PR of the issue blocking it, if one does.
  const exists = (await $`git rev-parse --verify --quiet refs/heads/${branch}`.nothrow().quiet()).exitCode === 0;
  if (!exists) {
    delete progress.parent;
    delete progress.pastParents;
    if (run.bug !== true && config.stack.blockers) {
      tui.start("setup", "reading blocked-by links");
      const parent = await findParent(config, issue);
      if (parent !== undefined) {
        progress.parent = parent;
        tui.activity(`stacking on ${parent.branch} (PR #${parent.pr})`);
      }
    }
    await save();
  }
  // An existing branch is checked out as it is, and its parent's branch may be gone once that PR
  // merged; the restack below moves it, so only a new branch is cut from the parent.
  const cutFrom = exists ? base : (stackedOn() ?? base);
  tui.start("setup", "container and bun install");
  // So a new branch builds on the latest main, or its parent's latest commits.
  if (cutFrom.startsWith("origin/")) await $`git fetch -q origin ${cutFrom.slice("origin/".length)}`.quiet();
  await using sandbox = await openSandbox(branch, cutFrom, run);
  const worktree = sandbox.worktreePath;
  const out = `${worktree}/out`;
  for (const dir of config.keep) {
    if (existsSync(saved(dir))) cpSync(saved(dir), `${worktree}/${dir}`, { recursive: true, force: false });
  }
  tui.done("setup");

  // Writes state.json and saves the kept directories.
  const saveAll = async (): Promise<void> => {
    await save();
    for (const dir of config.keep) {
      const live = `${worktree}/${dir}`;
      if (existsSync(live)) cpSync(live, saved(dir), { recursive: true, force: true });
    }
  };
  const record = async (name: string, extra: Omit<Progress, "done"> = {}): Promise<void> => {
    progress = { ...progress, ...extra, done: [...progress.done, name] };
    await saveAll();
  };

  // One pipeline step: skipped if an earlier run finished it, recorded once it is done.
  const phase = async (name: string, note: string, body: () => Promise<void>): Promise<void> => {
    enter(name);
    if (progress.done.includes(name)) {
      tui.skip(name, "done in an earlier run");
      return;
    }
    tui.start(name, note);
    await body();
    tui.done(name);
    await record(name);
  };

  // One agent session, shown under the TUI step `tuiStep`; `name` also names its log file.
  const step = async (
    tuiStep: string,
    name: string,
    agent: typeof OPUS,
    prompt: string,
    promptArgs: Record<string, string> = {},
  ): Promise<void> => {
    const promptFile = promptPath(prompt);
    const log = `${logs}/${name}.log`;
    writing(log);
    // A stacked branch's review, fixes and PR see only this issue's diff, not its parent's.
    const args = { ...config.args, ISSUE_NUMBER: issue, BASE: stackedOn() ?? config.compare, ...promptArgs };
    const result = await sandbox.run({
      name,
      agent,
      promptFile,
      promptArgs: await argsFor(promptFile, args),
      logging: { type: "file", path: log, onAgentStreamEvent: tui.event },
      signal,
    });
    for (const { usage } of result.iterations) tui.tokens(tuiStep, usage);
    tui.activity(`${name}: ${result.commits.length} commit(s)`);
    runs.push({ step: `#${issue} ${name}`, result });
  };

  // Moves the branch's own commits (those not in `upstream`) onto `onto`: by git when that is
  // clean, otherwise by an agent resolving the conflicts (stack.md). Only for an unpushed branch,
  // or one about to be force-pushed: it rewrites history.
  const restackOnto = async (tuiStep: string, onto: string, upstream: string): Promise<void> => {
    if (await rebaseOnto(worktree, onto, upstream)) return;
    tui.activity(`rebase onto ${onto} conflicts: resolving (Opus)`);
    await step(tuiStep, `stack-${Date.now()}`, OPUS, "stack.md", { ONTO: onto, UPSTREAM: upstream });
    const onIt = await $`git merge-base --is-ancestor ${onto} HEAD`.cwd(worktree).nothrow().quiet();
    if (onIt.exitCode !== 0) throw new Error(`the agent did not rebase the branch onto ${onto}`);
  };

  // A rerun of a stacked branch first catches up with its parent.
  const published = progress.done.includes("publish") && progress.commented !== true;
  const parent = progress.parent;
  if (exists && parent !== undefined) {
    enter("setup");
    // Until the push, a failed restack puts the branch back, so state.json (which still names the
    // parent and its sha) matches the branch and the next run restacks from the same place.
    const before = await tipOf("HEAD", worktree);
    const pushed = published ? await tipOf(`origin/${branch}`) : undefined;
    try {
      await restack(parent);
    } catch (error) {
      const moved = published && (await tipOf(`origin/${branch}`)) !== pushed;
      if (!moved) await $`git reset -q --hard ${before}`.cwd(worktree).nothrow().quiet();
      throw error;
    }
    tui.done("setup");
  }
  if (restackOnly) return progress;

  async function restack(parent: Parent): Promise<void> {
    const view: unknown = await $`gh pr view ${parent.pr} --json state,headRefOid`.quiet().json();
    const { state, head } = prState(view);
    if (state === "MERGED") {
      // A squash merge puts the parent's work on main as one new commit, so the branch's own
      // commits move onto main; merging main in would conflict with the parent's own commits.
      tui.start("setup", `parent PR #${parent.pr} merged: rebasing onto main`);
      await $`git fetch -q origin main`.quiet();
      await restackOnto("setup", "origin/main", parent.sha);
      if (published) await recheck(sandbox, signal);
      // An unpublished branch's check ran before the rebase, so it runs again.
      else progress.done = progress.done.filter((name) => name !== "check");
      progress = unstack(progress);
      await save();
      if (published) {
        await $`git push -q --force-with-lease origin ${branch}`.cwd(worktree).quiet();
        // The PR now goes into main, so the "Stacked on" line is no longer true.
        const pr = progress.url ?? branch;
        const text = (await $`gh pr view ${pr} --json body --jq .body`.quiet().text()).trimEnd();
        const file = `${out}/pipeline/pr-body-restacked.md`;
        await Bun.write(file, withoutStackNote(text));
        await $`gh pr edit ${pr} --base main --body-file ${file}`.cwd(worktree).quiet();
      }
      tui.activity(`restacked onto main; PR #${parent.pr} merged`);
    } else if (state === "OPEN" && head !== parent.sha) {
      // The parent moved on. The branch may be pushed, so its parent is merged in, not rebased onto.
      tui.start("setup", `parent PR #${parent.pr} has new commits: merging them in`);
      await $`git fetch -q origin ${parent.branch}`.quiet();
      if (!(await mergeIn(worktree, `origin/${parent.branch}`))) {
        tui.activity(`merging ${parent.branch} conflicts: resolving (Opus)`);
        await step("setup", `sync-${Date.now()}`, OPUS, "sync.md", { UPSTREAM: `origin/${parent.branch}` });
      }
      const merged = await $`git merge-base --is-ancestor origin/${parent.branch} HEAD`.cwd(worktree).nothrow().quiet();
      if (merged.exitCode !== 0) throw new Error(`the agent did not merge origin/${parent.branch}`);
      if (published) await recheck(sandbox, signal);
      else progress.done = progress.done.filter((name) => name !== "check");
      progress.parent = { ...parent, sha: await tipOf(`origin/${parent.branch}`) };
      await save();
      if (published) await $`git push -q origin ${branch}`.cwd(worktree).quiet();
    } else if (state === "CLOSED") {
      tui.activity(`\u001B[33mparent PR #${parent.pr} was closed unmerged\u001B[0m; the branch still holds its work`);
    }
  }

  await phase("implement", "Opus", async () => {
    if (answering) await step("implement", `address-${progress.rounds}`, OPUS, "address.md");
    else await step("implement", "implement", OPUS, "implement.md");
    // The agent stops here when the issue needs work that is on no branch it can build on.
    const blocked = `${out}/pipeline/blocked.md`;
    if (existsSync(blocked)) {
      const reason = (await Bun.file(blocked).text()).trim();
      rmSync(blocked);
      throw new Halt(`blocked: ${firstSaid(reason)}`, `implement is blocked: ${reason}`);
    }
  });
  await phase("review", "Opus", async () => {
    await step("review", "review", OPUS, "review.md");
  });

  // The review leaves fixes it never checked; this runs the check, and refixes until it is green.
  const checkGreen = async (round: number): Promise<boolean> => {
    tui.start("check", round === 1 ? "bun run check" : `bun run check, after fix round ${round - 1}`);
    const check = await untilAborted(sandbox.exec("bun run check"), signal);
    if (check.exitCode === 0) return true;
    tui.activity(`\u001B[31mbun run check failed\u001B[0m (round ${round})`);
    if (round > MAX_FIX_ROUNDS) return false;
    // A file, not a prompt arg: prompt args are pasted in before !`...` blocks run.
    await Bun.write(`${out}/pipeline/check.log`, `${check.stdout}\n${check.stderr}`);
    tui.start("check", `fixing, round ${round} of ${MAX_FIX_ROUNDS} (Sonnet)`);
    await step("check", `fix-check-${round}`, SONNET, "fix.md", {
      TASK: "`bun run check` fails; its output is in `out/pipeline/check.log`. Make it pass by fixing the code, never the rules. Each failure is one item; use its tool and file as the id.",
    });
    return checkGreen(round + 1);
  };
  const runCheck = async (): Promise<boolean> => {
    const green = await checkGreen(1);
    if (green) tui.done("check", "green");
    else tui.fail("check", `red after ${MAX_FIX_ROUNDS} fix rounds; PR will be a draft`);
    return green;
  };
  // A gate failure sends the run back to fix, with gate.md as its task, once more in this run.
  for (let attempt = 1; ; attempt++) {
    // The review fixes its own findings, so fix only runs for a gate failure.
    enter("fix");
    if (progress.done.includes("fix")) tui.skip("fix", "done in an earlier run");
    else if (progress.gated !== true) await skipStep("fix", "the review fixed its findings");
    else
      await phase("fix", "Sonnet", async () => {
        await step("fix", "fix", SONNET, "fix.md", {
          TASK: "The PR was not published: the run broke the gate rules in `out/pipeline/gate.md`. Each line is one item; use its rule as the id.",
        });
      });

    enter("check");
    if (progress.done.includes("check")) tui.skip("check", "done in an earlier run");
    else await record("check", { green: await runCheck() });

    // Which files the work touches is only known once it is done, so conflicts with other open PRs
    // are checked here, before anything is pushed, while the branch can still be rebased.
    enter("stack");
    if (progress.done.includes("stack")) tui.skip("stack", "done in an earlier run");
    else if (run.bug === true || !config.stack.conflicts || answering)
      await skipStep("stack", run.bug === true ? "a bug lands on main alone" : "off");
    else {
      tui.start("stack", "trial-merging against open PRs");
      const found = await conflictTarget(config, issue, worktree, progress.parent);
      if (found !== undefined && found.parent === progress.parent) {
        // Conflicts only with PRs it cannot also stack on; the PR body names them.
        tui.done("stack", `stays on PR #${found.parent.pr}`);
        await record("stack", { alsoConflicts: found.others.map(({ number }) => number) });
      } else if (found === undefined) {
        tui.done("stack", "no conflicts with open PRs");
        await record("stack");
      } else {
        const { parent: target, others } = found;
        tui.start("stack", `conflicts with PR #${target.pr}: rebasing onto ${target.branch}`);
        // The branch's own commits start where it was cut: its parent, or the base (main for a HEAD base).
        await restackOnto("stack", `origin/${target.branch}`, stackedOn() ?? (base === "HEAD" ? config.compare : base));
        progress.parent = target;
        const also = others.map(({ number }) => number);
        await save();
        enter("check");
        const green = await runCheck();
        tui.done("stack", `stacked on PR #${target.pr}`);
        await record("stack", { green, ...(also.length === 0 ? {} : { alsoConflicts: also }) });
      }
    }
    await phase("pr", "Sonnet", async () => {
      await step("pr", "pr", SONNET, "pr.md");
    });

    enter("gate");
    if (progress.done.includes("gate")) {
      tui.skip("gate", "done in an earlier run");
      break;
    }
    tui.start("gate", "pr.json, evidence, commits" + (config.gates.length > 0 ? ", repo rules" : ""));
    const failures = await gate(
      // A stacked branch's commits are counted from its parent, as the prompts see them.
      await artefacts(
        worktree,
        issue,
        stackedOn() ?? config.compare,
        config.args["EVIDENCE"] ?? "",
        parentIssues(progress),
      ),
      config.gates,
    );
    if (failures.length === 0) {
      delete progress.gated;
      tui.done("gate");
      await record("gate");
      break;
    }
    await Bun.write(`${out}/pipeline/gate.md`, `${report(failures)}\n`);
    progress = rewind(progress);
    await saveAll();
    if (attempt >= MAX_GATE_ATTEMPTS)
      throw new Halt(
        `gate failed: ${[...new Set(failures.map(({ rule }) => rule))].join(", ")}`,
        `the gate failed; no PR opened. Rerun to fix:\n${report(failures)}`,
      );
    tui.fail("gate", `${failures.length} failure(s); back to fix`);
  }

  enter("publish");
  if (progress.done.includes("publish")) tui.skip("publish", progress.url ?? "");
  else {
    tui.start("publish", "push and gh pr create");
    // The parent PR may have merged (and its branch been deleted) while this run worked, and a PR
    // cannot target a deleted branch: catch up with the parent first, and recheck if that moved it.
    if (progress.parent !== undefined) {
      await restack(progress.parent);
      if (!progress.done.includes("check")) await record("check", { green: await runCheck() });
      tui.start("publish", "push and gh pr create");
    }
    const green = progress.green ?? false;
    const pipeline = `${out}/pipeline`;
    const pr: unknown = await Bun.file(`${pipeline}/pr.json`).json();
    if (!isPrSpec(pr)) throw new Error(`${pipeline}/pr.json is not {"title": string, "attach": string[]}`);
    const body = `${pipeline}/pr-body.md`;
    // The stacking line goes first, so the owner sees the merge order before anything else.
    if (progress.parent !== undefined) {
      const text = await Bun.file(body).text();
      const note = stackNote(progress.parent, progress.alsoConflicts);
      if (!text.startsWith(note)) await Bun.write(body, `${note}\n\n${withoutStackNote(text)}`);
    }
    // An audit can end with nothing to change and no commits, and GitHub refuses a PR with no
    // commits, so the PR body goes on the issue as a comment instead.
    const commits = Number((await $`git rev-list --count ${stackedOn() ?? base}..${branch}`.quiet().text()).trim());
    if (commits === 0) {
      const url = (await $`gh issue comment ${issue} --body-file ${body}`.quiet().text()).trim();
      tui.done("publish", url);
      await record("publish", { url, commented: true });
    } else {
      const attachments = pr.attach.flatMap((path) => ["--attach", path]);
      // An earlier failed publish may have pushed the branch before a restack rewrote it.
      await $`git push -q -u --force-with-lease origin ${branch}`.quiet();
      // A run stopped after gh pr create but before recording it has already opened the PR.
      const existing = (await $`gh pr view ${branch} --json url --jq .url`.nothrow().quiet().text()).trim();
      const draft = green ? [] : ["--draft"];
      const target = progress.parent === undefined ? [] : ["--base", progress.parent.branch];
      if (existing !== "" && answering) {
        await $`gh pr edit ${existing} --title ${pr.title} --body-file ${body} ${attachments}`.cwd(worktree).quiet();
        if (green) await $`gh pr ready ${existing}`.nothrow().quiet();
      }
      const url =
        existing ||
        (
          await $`gh pr create --head ${branch} ${target} --title ${pr.title} --body-file ${body} ${draft} ${attachments}`
            .cwd(worktree)
            .quiet()
            .text()
        ).trim();
      tui.done("publish", url);
      await record("publish", { url });
    }
  }
  return progress;

  async function skipStep(name: string, why: string): Promise<void> {
    tui.skip(name, why);
    await record(name);
  }
}

// Fast-forwards a local branch that lags its pushed copy. Git will not move a branch checked out
// in a worktree, which a run that stopped, or left untracked files, keeps; that worktree is
// fast-forwarded instead.
async function catchUp(branch: string): Promise<void> {
  await $`git fetch -q origin ${branch}`.quiet();
  if ((await tipOf(branch)) === (await tipOf(`origin/${branch}`))) return;
  const behind = await $`git merge-base --is-ancestor ${branch} origin/${branch}`.nothrow().quiet();
  if (behind.exitCode !== 0) return;
  const holder = worktreeHolding(await $`git worktree list --porcelain`.quiet().text(), branch);
  if (holder === undefined) await $`git branch -f ${branch} origin/${branch}`.quiet();
  else await $`git merge -q --ff-only origin/${branch}`.cwd(holder).quiet();
}

/** The worktree `branch` is checked out in, from `git worktree list --porcelain`, if any. */
export function worktreeHolding(porcelain: string, branch: string): string | undefined {
  const entry = porcelain
    .split("\n\n")
    .map((block) => block.split("\n"))
    .find((lines) => lines.includes(`branch refs/heads/${branch}`));
  return entry?.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
}

// Reruns `bun run check` after a restack of a branch whose PR is open; a red check must not be pushed.
async function recheck(
  sandbox: { exec: (command: string) => Promise<{ exitCode: number }> },
  signal: AbortSignal,
): Promise<void> {
  const check = await untilAborted(sandbox.exec("bun run check"), signal);
  if (check.exitCode !== 0) throw new Error("bun run check fails after restacking; nothing was pushed");
}

// A PR's state (OPEN, CLOSED or MERGED) and head commit, from `gh pr view --json state,headRefOid`.
function prState(view: unknown): { state: string; head: string } {
  if (typeof view !== "object" || view === null) return { state: "", head: "" };
  const state = "state" in view && typeof view.state === "string" ? view.state : "";
  const head = "headRefOid" in view && typeof view.headRefOid === "string" ? view.headRefOid : "";
  return { state, head };
}

// The run's outputs and the facts about them the gate needs, from the worktree and `gh`.
async function artefacts(
  worktree: string,
  issue: string,
  compare: string,
  evidenceDir: string,
  parents: number[],
): Promise<RunArtefacts> {
  const pipeline = `${worktree}/out/pipeline`;
  const read = async (file: string): Promise<string> =>
    existsSync(`${pipeline}/${file}`) ? Bun.file(`${pipeline}/${file}`).text() : "";
  const text = await read("pr.json");
  const parsed: unknown = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })();
  const pr = isPrSpec(parsed) ? parsed : null;
  const lines = async (command: ReturnType<typeof $>): Promise<string[]> =>
    (await command.cwd(worktree).quiet().text()).split("\n").filter(Boolean);
  const dir = `${worktree}/${evidenceDir}`;
  return {
    issue: { number: Number(issue), parents },
    review: await read("review.md"),
    prBody: await read("pr-body.md"),
    pr,
    commits: await lines($`git log --format=%s ${compare}..HEAD`),
    evidenceDir,
    evidence: existsSync(dir)
      ? readdirSync(dir, { recursive: true, encoding: "utf8" }).map((path) => `${evidenceDir}/${path}`)
      : [],
    worktree,
    changed: await lines($`git diff --name-only ${compare}...HEAD`),
  };
}

interface Feedback {
  /** The comments as Markdown, or "" when there are none. */
  comments: string;
  count: number;
  seen: string | undefined;
}

// The owner's comments on the run's open PR made after `progress.feedbackSeen`, or null when
// there is no open PR to take feedback from.
async function newFeedback(progress: Progress, signal: AbortSignal): Promise<Feedback | null> {
  const { url } = progress;
  if (url === undefined || progress.commented === true || !progress.done.includes("publish")) return null;
  const state = (await untilAborted($`gh pr view ${url} --json state --jq .state`.quiet().text(), signal)).trim();
  if (state !== "OPEN") return null;
  const owner = (await $`gh api user --jq .login`.quiet().text()).trim();
  const number = url.split("/").at(-1) ?? "";
  // Conversation comments, review summaries and inline review comments, each as {at, body, where}.
  const mine = `select(.user.login == "${owner}" and (.body // "") != "")`;
  const found: Comment[] = [
    ...(await query(`issues/${number}/comments`, `.[] | ${mine} | {at: .created_at, body, where: "comment"}`)),
    ...(await query(`pulls/${number}/reviews`, `.[] | ${mine} | {at: .submitted_at, body, where: "review"}`)),
    ...(await query(
      `pulls/${number}/comments`,
      `.[] | ${mine} | {at: .created_at, body, where: "\\(.path):\\(.line // .original_line)", hunk: .diff_hunk}`,
    )),
  ].filter((value): value is Comment => isComment(value));
  // Each list comes oldest first; ISO 8601 times compare as strings.
  const fresh = found.filter(({ at }) => progress.feedbackSeen === undefined || at > progress.feedbackSeen);
  const comments = fresh
    .map(({ at, body, where, hunk }) =>
      [`## ${where} (${at})`, hunk === undefined ? "" : `\n\`\`\`diff\n${hunk}\n\`\`\`\n`, body].join("\n"),
    )
    .join("\n\n");
  const seen = fresh.reduce<string | undefined>(
    (latest, { at }) => (latest === undefined || at > latest ? at : latest),
    progress.feedbackSeen,
  );
  return { comments, count: fresh.length, seen };
}

// One JSON value per line from a paginated GitHub API read; gh fills {owner}/{repo} from the checkout.
async function query(path: string, jq: string): Promise<unknown[]> {
  const text = await $`gh api --paginate repos/{owner}/{repo}/${path} --jq ${jq}`.quiet().text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line): unknown => JSON.parse(line));
}

interface Comment {
  at: string;
  body: string;
  where: string;
  hunk?: string;
}

function isComment(value: unknown): value is Comment {
  if (typeof value !== "object" || value === null) return false;
  return "at" in value && typeof value.at === "string" && "body" in value && typeof value.body === "string";
}

// Rejects as soon as `signal` aborts, for work that takes no AbortSignal of its own.
async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const settled = await Promise.race([
    work,
    new Promise<never>((_, reject) => {
      if (signal.aborted) reject(asError(signal.reason));
      signal.addEventListener(
        "abort",
        () => {
          reject(asError(signal.reason));
        },
        { once: true },
      );
    }),
  ]);
  return settled;
}

// The container for `branch` (cut from `base` if the branch is new), with dependencies installed.
async function openSandbox(
  branch: string,
  base: string,
  run: Pick<IssueRun, "signal" | "serialize">,
): ReturnType<typeof createSandbox> {
  // Sandcastle adds SIGINT/SIGTERM listeners that remove the container and exit(1) at once,
  // before the caller can close its progress view or say how to carry on. Its exit listener
  // stays, so a crash still removes the container.
  const listening = {
    SIGINT: new Set(process.listeners("SIGINT")),
    SIGTERM: new Set(process.listeners("SIGTERM")),
  };
  const create = async (): ReturnType<typeof createSandbox> => {
    const created = await createSandbox({
      branch,
      baseBranch: base,
      sandbox: docker(),
      hooks: { sandbox: { onSandboxReady: [{ command: "bun install --frozen-lockfile" }] } },
    });
    return created;
  };
  const creating = run.serialize ? run.serialize(create) : create();
  let started: Awaited<typeof creating>;
  try {
    started = await untilAborted(creating, run.signal);
  } catch (error) {
    // Stopped during setup: let the container come up, then remove it.
    const [late] = await Promise.allSettled([creating]);
    if (late?.status === "fulfilled") await late.value.close();
    throw error;
  }
  for (const signalName of ["SIGINT", "SIGTERM"] as const) {
    for (const listener of process.listeners(signalName)) {
      if (!listening[signalName].has(listener)) process.off(signalName, listener);
    }
  }
  return started;
}

/**
 * Merges `upstream` (origin/main, or a stacked branch's parent) into the issue's pushed branch,
 * with an agent resolving the conflicts (sync.md), and pushes the merge once `bun run check`
 * passes. Throws if any of that fails.
 */
export async function resolveConflicts(
  run: Omit<IssueRun, "base" | "fresh" | "onStep">,
  upstream = "origin/main",
): Promise<void> {
  const { config, issue, reporter: tui, signal, runs } = run;
  const branch = config.branch(issue);
  const logs = logsFor(issue);
  await $`git fetch -q origin ${upstream.slice("origin/".length)} ${branch}`.quiet();
  // The local branch may lag the pushed one; the merge must build on what the PR holds.
  await $`git branch -f ${branch} origin/${branch}`.quiet();
  await using sandbox = await openSandbox(branch, upstream, run);
  const name = `sync-${Date.now()}`;
  const log = `${logs}/${name}.log`;
  try {
    const promptFile = promptPath("sync.md");
    const result = await sandbox.run({
      name,
      agent: OPUS,
      promptFile,
      promptArgs: await argsFor(promptFile, { ...config.args, ISSUE_NUMBER: issue, UPSTREAM: upstream }),
      logging: { type: "file", path: log, onAgentStreamEvent: tui.event },
      signal,
    });
    runs.push({ step: `#${issue} sync`, result });
    const merged = await $`git merge-base --is-ancestor ${upstream} ${branch}`.nothrow().quiet();
    if (merged.exitCode !== 0) throw new Error(`the agent did not merge ${upstream}`);
    const check = await untilAborted(sandbox.exec("bun run check"), signal);
    if (check.exitCode !== 0) throw new Error("bun run check fails after the merge");
    await $`git push -q origin ${branch}`.quiet();
  } catch (error) {
    journal(logs, "sync", signal.aborted ? "stopped" : "failed", signal.aborted ? undefined : error, log);
    throw error;
  }
}

/** A run that stopped on purpose, not by a fault: `reason` is the few words the progress view shows. */
export class Halt extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

const BRIEF = 60;

/** The first line of an agent's note that says something, without markdown markers or a bare heading like "Blocked". */
export function firstSaid(note: string): string {
  const lines = note.split("\n").map((line) => line.replace(/^[\s#>*_-]+/u, "").trim());
  return lines.find((line) => line !== "" && !/^blocked:?$/iu.test(line)) ?? "";
}

/** Why a run stopped, in a few words for the progress view: a halt's reason, or the error's first line. */
export function brief(error: unknown): string {
  const text = error instanceof Halt ? error.reason : error instanceof Error ? error.message : String(error);
  const line = text.split("\n")[0]?.trim() ?? "";
  return line.length > BRIEF ? `${line.slice(0, BRIEF - 1)}…` : line;
}

/** One line saying what a finished run left behind. */
export function outcome(progress: Progress): string {
  if (progress.commented === true) return "No commits, so no PR; the PR body is a comment on the issue";
  return progress.green === true ? "PR" : "Draft PR (check failing)";
}

const asError = (reason: unknown): Error => (reason instanceof Error ? reason : new Error("Interrupted"));

export function containers(): string[] {
  const ps = Bun.spawnSync(["docker", "ps", "-q", "--filter", "name=sandcastle-"]);
  return ps.stdout.toString().split("\n").filter(Boolean);
}

export function usageReport(runs: IssueRun["runs"]): string[] {
  return runs.flatMap(({ step: name, result }) =>
    result.iterations.map(({ sessionId, usage }) => {
      const tokens = usage
        ? `in ${usage.inputTokens}, out ${usage.outputTokens}, cache write ${usage.cacheCreationInputTokens}, cache read ${usage.cacheReadInputTokens}`
        : "no usage reported";
      return `${name} (${sessionId ?? "no id"}): ${tokens}`;
    }),
  );
}

/** The stacking a run keeps when its steps start over (--fresh, a feedback round). */
function stacking({ parent, pastParents }: Progress): Pick<Progress, "parent" | "pastParents"> {
  return { ...(parent === undefined ? {} : { parent }), ...(pastParents === undefined ? {} : { pastParents }) };
}

/** Progress once the parent has merged and the branch moved onto main: the parent's issue is kept in `pastParents`. */
export function unstack(progress: Progress): Progress {
  const { parent, ...rest } = progress;
  if (parent === undefined || parent.issue === "") return rest;
  return { ...rest, pastParents: [...(progress.pastParents ?? []), parent.issue] };
}

/** The issues of every PR the branch is or was stacked on, for the gate. */
export function parentIssues({ parent, pastParents = [] }: Progress): number[] {
  return [...(parent === undefined ? [] : [parent.issue]), ...pastParents].filter((n) => n !== "").map(Number);
}

function isProgress(value: unknown): value is Progress {
  if (typeof value !== "object" || value === null || !("done" in value)) return false;
  const { done } = value;
  if ("parent" in value && !isParent(value.parent)) return false;
  const past: unknown = "pastParents" in value ? value.pastParents : [];
  if (!Array.isArray(past) || !past.every((n: unknown) => typeof n === "string")) return false;
  return Array.isArray(done) && done.every((name: unknown) => typeof name === "string");
}

function isPrSpec(value: unknown): value is { title: string; attach: string[] } {
  if (typeof value !== "object" || value === null) return false;
  if (!("title" in value) || !("attach" in value)) return false;
  const { title, attach } = value;
  return (
    typeof title === "string" && Array.isArray(attach) && attach.every((path: unknown) => typeof path === "string")
  );
}
