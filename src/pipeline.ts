import { claudeCode, createSandbox, type SandboxRunResult } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { $ } from "bun";
import { cpSync, existsSync, rmSync } from "node:fs";
import { argsFor, promptPath, type Resolved } from "./config.ts";
import { describe, journal } from "./journal.ts";
import type { Tui } from "./tui.ts";

// The pipeline for one issue, shared by the single-issue and batch runners.
//
// One container, one branch (config.branch, cut from config.base):
//   implement (Opus) → review and triage (Opus) → fix (Sonnet) → check, refixing up to 3 times → PR body (Sonnet)
// then it pushes the branch and opens the PR. It is a draft if the check is still red.
// A branch with no commits (an audit that only filed issues) gets the PR body as an issue comment instead.
// Each agent's full output goes to .sandcastle/logs/<issue>/, and every failure or stop to its error.log.
//
// Running the same issue again skips the steps an earlier run finished (kept in
// .sandcastle/logs/<issue>/state.json) and starts the stopped step over on the same branch.
// `fresh` forgets those and starts from implement; the branch keeps its commits.
//
// Running it again once the PR is open starts a feedback round if the owner (the `gh` user) has
// commented on the PR since the last round: their comments go to out/pipeline/feedback.md and
// implement (address.md) → review → fix → check → PR body run again, then publish pushes and
// rewrites the PR's title and body. With no new comments the run does nothing.
const MAX_FIX_ROUNDS = 3;
const OPUS = claudeCode("claude-opus-5-5", { effort: "low" });
const SONNET = claudeCode("claude-sonnet-5-5", { effort: "low" });

export const STEPS = ["feedback", "setup", "implement", "review", "fix", "check", "pr", "publish"] as const;

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
  /** How the last run ended, if it did not finish; error.log has the whole story. */
  failed?: { step: string; at: string; error: string };
}

export interface IssueRun {
  config: Resolved;
  issue: string;
  /** Ref a new branch is cut from, overriding config.base. */
  base?: string;
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
    const what = run.signal.aborted ? `stopped: ${describe(run.signal.reason)}` : "failed";
    journal(logs, step, what, run.signal.aborted ? undefined : error, agentLog);
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
  const stored: unknown = run.fresh !== true && existsSync(stateFile) ? await Bun.file(stateFile).json() : undefined;
  let progress: Progress = isProgress(stored) ? stored : { done: [] };
  delete progress.failed;

  const enter = (name: string): void => {
    run.onStep?.(name);
  };

  // A published PR with new owner comments starts a feedback round: every step after setup runs again.
  enter("feedback");
  const feedback = await newFeedback(progress, signal);
  if (feedback === null)
    tui.skip("feedback", progress.url === undefined ? "no PR yet" : "no open PR, or a round to carry on");
  else if (feedback.comments === "") {
    tui.done("feedback", "no new comments; nothing to do");
    return progress;
  } else {
    const rounds = (progress.rounds ?? 0) + 1;
    progress = {
      done: [],
      rounds,
      ...(progress.url === undefined ? {} : { url: progress.url }),
      ...(feedback.seen === undefined ? {} : { feedbackSeen: feedback.seen }),
    };
    // The last round's review and fixes would read as this round's.
    for (const file of ["review.md", "fixes.md", "check.log"]) rmSync(`${savedOut}/pipeline/${file}`, { force: true });
    await Bun.write(`${savedOut}/pipeline/feedback.md`, feedback.comments);
    await Bun.write(`${logs}/feedback-${rounds}.md`, feedback.comments);
    // The local branch may lag the pushed one (the owner can push to the PR too).
    await $`git fetch -q origin ${branch}`.quiet();
    const behind = await $`git merge-base --is-ancestor ${branch} origin/${branch}`.nothrow().quiet();
    if (behind.exitCode === 0) await $`git branch -f ${branch} origin/${branch}`.quiet();
    tui.done("feedback", `round ${rounds}: ${feedback.count} comment(s)`);
  }
  const answering = progress.rounds !== undefined && existsSync(`${savedOut}/pipeline/feedback.md`);

  enter("setup");
  tui.start("setup", "container and bun install");
  // So a new branch builds on the latest main.
  if (base.startsWith("origin/")) await $`git fetch -q origin ${base.slice("origin/".length)}`.quiet();
  await using sandbox = await openSandbox(branch, base, run);
  const out = `${sandbox.worktreePath}/out`;
  for (const dir of config.keep) {
    if (existsSync(saved(dir))) cpSync(saved(dir), `${sandbox.worktreePath}/${dir}`, { recursive: true, force: false });
  }
  tui.done("setup");

  const record = async (name: string, extra: Omit<Progress, "done"> = {}): Promise<void> => {
    progress = { ...progress, ...extra, done: [...progress.done, name] };
    await Bun.write(stateFile, JSON.stringify(progress, null, 2));
    for (const dir of config.keep) {
      const live = `${sandbox.worktreePath}/${dir}`;
      if (existsSync(live)) cpSync(live, saved(dir), { recursive: true, force: true });
    }
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
    const result = await sandbox.run({
      name,
      agent,
      promptFile,
      promptArgs: await argsFor(promptFile, { ...config.args, ISSUE_NUMBER: issue, ...promptArgs }),
      logging: { type: "file", path: log, onAgentStreamEvent: tui.event },
      signal,
    });
    for (const { usage } of result.iterations) tui.tokens(tuiStep, usage);
    tui.activity(`${name}: ${result.commits.length} commit(s)`);
    runs.push({ step: `#${issue} ${name}`, result });
  };

  await phase("implement", "Opus", async () => {
    if (answering) await step("implement", `address-${progress.rounds}`, OPUS, "address.md");
    else await step("implement", "implement", OPUS, "implement.md");
    // The agent stops here, rather than building on another agent's unmerged branch, when the
    // issue needs work that is not on this branch yet.
    const blocked = `${out}/pipeline/blocked.md`;
    if (existsSync(blocked)) {
      const reason = (await Bun.file(blocked).text()).trim();
      rmSync(blocked);
      throw new Error(`implement is blocked: ${reason}`);
    }
  });
  await phase("review", "Opus", async () => {
    await step("review", "review", OPUS, "review.md");
  });
  await phase("fix", "Sonnet", async () => {
    await step("fix", "fix", SONNET, "fix.md", {
      TASK: "The review findings are in `out/pipeline/review.md`. If it says `No findings.`, write that to `out/pipeline/fixes.md` and stop.",
    });
  });

  // The fix agent is told to leave the check green; this makes sure, and refixes if not.
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
  enter("check");
  if (progress.done.includes("check")) tui.skip("check", "done in an earlier run");
  else {
    const green = await checkGreen(1);
    if (green) tui.done("check", "green");
    else tui.fail("check", `red after ${MAX_FIX_ROUNDS} fix rounds; PR will be a draft`);
    await record("check", { green });
  }
  const green = progress.green ?? false;

  await phase("pr", "Sonnet", async () => {
    await step("pr", "pr", SONNET, "pr.md", { CHECK: green ? "passing" : "FAILING" });
  });

  enter("publish");
  if (progress.done.includes("publish")) tui.skip("publish", progress.url ?? "");
  else {
    tui.start("publish", "push and gh pr create");
    const pipeline = `${out}/pipeline`;
    const pr: unknown = await Bun.file(`${pipeline}/pr.json`).json();
    if (!isPrSpec(pr)) throw new Error(`${pipeline}/pr.json is not {"title": string, "attach": string[]}`);
    // An audit can end with only follow-up issues and no commits, and GitHub refuses a PR with no
    // commits, so the PR body goes on the issue as a comment instead.
    const commits = Number((await $`git rev-list --count ${base}..${branch}`.quiet().text()).trim());
    if (commits === 0) {
      const url = (await $`gh issue comment ${issue} --body-file ${pipeline}/pr-body.md`.quiet().text()).trim();
      tui.done("publish", url);
      await record("publish", { url, commented: true });
    } else {
      const attachments = pr.attach.flatMap((path) => ["--attach", path]);
      await $`git push -q -u origin ${branch}`.quiet();
      // A run stopped after gh pr create but before recording it has already opened the PR.
      const existing = (await $`gh pr view ${branch} --json url --jq .url`.nothrow().quiet().text()).trim();
      const draft = green ? [] : ["--draft"];
      if (existing !== "" && answering) {
        await $`gh pr edit ${existing} --title ${pr.title} --body-file ${pipeline}/pr-body.md ${attachments}`
          .cwd(sandbox.worktreePath)
          .quiet();
        if (green) await $`gh pr ready ${existing}`.nothrow().quiet();
      }
      const url =
        existing ||
        (
          await $`gh pr create --head ${branch} --title ${pr.title} --body-file ${pipeline}/pr-body.md ${draft} ${attachments}`
            .cwd(sandbox.worktreePath)
            .quiet()
            .text()
        ).trim();
      tui.done("publish", url);
      await record("publish", { url });
    }
  }
  return progress;
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
 * Merges origin/main into the issue's pushed branch, with an agent resolving the conflicts
 * (sync.md), and pushes the merge once `bun run check` passes. Throws if any of that fails.
 */
export async function resolveConflicts(run: Omit<IssueRun, "base" | "fresh" | "onStep">): Promise<void> {
  const { config, issue, reporter: tui, signal, runs } = run;
  const branch = config.branch(issue);
  const logs = logsFor(issue);
  await $`git fetch -q origin main ${branch}`.quiet();
  // The local branch may lag the pushed one; the merge must build on what the PR holds.
  await $`git branch -f ${branch} origin/${branch}`.quiet();
  await using sandbox = await openSandbox(branch, "origin/main", run);
  const name = `sync-${Date.now()}`;
  const log = `${logs}/${name}.log`;
  try {
    const promptFile = promptPath("sync.md");
    const result = await sandbox.run({
      name,
      agent: OPUS,
      promptFile,
      promptArgs: await argsFor(promptFile, { ...config.args, ISSUE_NUMBER: issue }),
      logging: { type: "file", path: log, onAgentStreamEvent: tui.event },
      signal,
    });
    runs.push({ step: `#${issue} sync`, result });
    const merged = await $`git merge-base --is-ancestor origin/main ${branch}`.nothrow().quiet();
    if (merged.exitCode !== 0) throw new Error("the agent did not merge origin/main");
    const check = await untilAborted(sandbox.exec("bun run check"), signal);
    if (check.exitCode !== 0) throw new Error("bun run check fails after the merge");
    await $`git push -q origin ${branch}`.quiet();
  } catch (error) {
    journal(logs, "sync", signal.aborted ? "stopped" : "failed", signal.aborted ? undefined : error, log);
    throw error;
  }
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

function isProgress(value: unknown): value is Progress {
  if (typeof value !== "object" || value === null || !("done" in value)) return false;
  const { done } = value;
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
