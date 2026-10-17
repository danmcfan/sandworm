import { $ } from "bun";
import { resolve, type Config, type Resolved } from "./config.ts";
import { describe, guard } from "./journal.ts";
import {
  brief,
  containers,
  logsFor,
  outcome,
  resolveConflicts,
  runIssue,
  usageReport,
  type IssueRun,
  type Reporter,
} from "./pipeline.ts";
import { blockersOf, BUG, nextIssue, order, Skip, type IssueStates, type Status } from "./stack.ts";
import { createBatchTui } from "./tui.ts";

const READY = "ready-for-agent";
const CI_POLL_MS = 30_000;
// No check at all after this long means CI is not coming.
const CI_START_MS = 5 * 60_000;
// A run that takes longer than this is stuck.
const CI_TIMEOUT_MS = 45 * 60_000;
// Times a bug's PR may have main merged in to clear conflicts before it is left for the owner.
const MAX_SYNCS = 2;

/**
 * `bun run sandcastle:batch [issues ...] [--workers N] [--fresh]`, where each issue is a number
 * (`12`) or an inclusive range (`10-20`). With none it takes every open ready-for-agent issue,
 * oldest first; a named issue that is closed, missing or lacks that label is skipped, and so is any
 * issue with a config.batch.skipLabels label (default `needs-owner`). An issue is started only
 * once every issue blocking it (GitHub issue dependencies) is closed.
 *
 * Each issue goes through the same pipeline as the single-issue runner, up to N at a time
 * (config.batch.workers, default 1). With config.batch.mergeBugs, bug issues (label `bug`) run
 * one at a time, never alongside another bug: each is cut from a freshly fetched origin/main and,
 * once its PR is green and CI passes, merged (squash) before the next bug starts, so every bug fix
 * builds on the ones before it. If main moves on and the PR comes to conflict with it, an agent
 * merges main in (sync.md) and CI runs again. A bug whose review left a spec finding won't-fix or an
 * `Owner decision:` note stays open instead. Other issues stop at an open PR for the owner.
 *
 * With config.stack.blockers, other issues run after the issues GitHub says block them (blocked-by
 * links), and an issue starts only once its blockers in the batch have published a PR, which it
 * stacks on (src/stack.ts). An issue in a dependency cycle, or whose blocker failed, is skipped.
 *
 * Ctrl-C stops every agent and removes the containers; a second Ctrl-C force-removes them and quits.
 * Rerunning carries each issue on from where it stopped, as the single-issue runner does.
 */
export async function runBatch(config: Config, args = process.argv.slice(2)): Promise<void> {
  const resolved = resolve(config);
  const fresh = args.includes("--fresh");
  const workersAt = args.indexOf("--workers");
  const workers = workersAt === -1 ? resolved.workers : Number(args[workersAt + 1]);
  if (!Number.isInteger(workers) || workers < 1) throw new Error("--workers takes a whole number of at least 1.");
  const named = [
    ...new Set(
      args.filter((arg, i) => arg !== "--fresh" && arg !== "--workers" && i !== workersAt + 1).flatMap(expand),
    ),
  ];

  const fetched: unknown[] =
    named.length > 0
      ? await Promise.all(
          named.map(async (n): Promise<unknown> => {
            const view = await $`gh issue view ${n} --json number,state,labels,body`.nothrow().quiet();
            return view.exitCode === 0 ? view.json() : { number: n, state: "MISSING", labels: [] };
          }),
        )
      : [
          await $`gh issue list --label ${READY} --state open --search sort:created-asc --limit 200 --json number,state,labels,body`
            .quiet()
            .json(),
        ].flat();
  const listed = fetched.filter((value) => isIssue(value));
  const has = (issue: Issue, label: string): boolean => issue.labels.some(({ name }) => name === label);
  const { ready, skipped } = triage(listed, resolved.skipLabels);
  if (ready.length === 0)
    throw new Error(`No open ${READY} issues to run${skipped.length > 0 ? ` (skipped ${skipped.join(", ")})` : ""}.`);

  const isBug = (issue: Issue): boolean => resolved.mergeBugs && has(issue, BUG);
  const bugs = ready.filter((issue) => isBug(issue)).map(({ number }) => String(number));
  const others = ready.filter((issue) => !isBug(issue)).map(({ number }) => String(number));

  // Bugs under mergeBugs never stack, so only the other issues' blockers are read.
  const blockedBy = new Map<string, string[]>();
  if (resolved.stack.blockers) {
    // Every listed issue's state and body are known already, and a blocker several issues name is looked up once.
    const states: IssueStates = new Map(
      listed.map(({ number, state }) => [String(number), Promise.resolve(state === "OPEN")]),
    );
    const bodies = new Map(listed.map(({ number, body }) => [String(number), body]));
    const read = await Promise.all(
      others.map(async (issue) => [issue, await blockersOf(issue, { body: bodies.get(issue), states })] as const),
    );
    for (const [issue, blockers] of read)
      blockedBy.set(
        issue,
        blockers.filter(({ open }) => open).map((blocker) => blocker.issue),
      );
  }
  const { order: ordered, cycles } = order(others, blockedBy);

  const batch = new Batch(resolved, fresh, bugs, ordered, workers, blockedBy);
  if (skipped.length > 0) batch.tui.activity(`Skipped: ${skipped.join(", ")}`);
  batch.skipped = skipped;
  for (const issue of cycles) batch.skip(issue, "in a dependency cycle, or blocked by an issue in one");
  await batch.run();
}

class Batch {
  readonly tui;
  readonly stop = new AbortController();
  readonly runs: IssueRun["runs"] = [];
  readonly results = new Map<string, string>();
  /** The step each running issue is on. */
  readonly running = new Map<string, string>();
  skipped: string[] = [];
  private setups: Promise<unknown> = Promise.resolve();
  private bugRunning = false;
  /** Every issue's status, so an issue can wait for its blockers to publish. */
  private readonly status = new Map<string, Status>();
  // Resolves the workers waiting for a blocker to finish.
  private wake = (): void => {};
  // Open blockers of each bug, read as the bug lane takes them, for the report.
  private readonly bugBlockers = new Map<string, number[]>();

  readonly config: Resolved;
  readonly fresh: boolean;
  readonly bugs: string[];
  readonly others: string[];
  readonly workers: number;
  readonly blockedBy: ReadonlyMap<string, string[]>;

  constructor(
    config: Resolved,
    fresh: boolean,
    bugs: string[],
    others: string[],
    workers: number,
    blockedBy: ReadonlyMap<string, string[]>,
  ) {
    this.config = config;
    this.fresh = fresh;
    this.bugs = bugs;
    this.others = others;
    this.workers = workers;
    this.blockedBy = blockedBy;
    for (const issue of [...bugs, ...others]) this.status.set(issue, "queued");
    this.tui = createBatchTui(`Sandcastle batch · ${bugs.length + others.length} issue(s) · ${workers} worker(s)`, [
      ...bugs.map((issue) => ({ issue, tag: BUG })),
      ...others.map((issue) => ({ issue, tag: "" })),
    ]);
  }

  /** Leaves an issue out of the run, saying why; its dependents are skipped in turn. */
  skip(issue: string, reason: string): void {
    this.tui.set(issue, "stopped", "setup", `skipped: ${reason}`);
    this.results.set(issue, `Skipped: ${reason}`);
    this.settle(issue, "failed");
  }

  private settle(issue: string, status: Status): void {
    this.status.set(issue, status);
    const wake = this.wake;
    this.wake = () => {};
    wake();
  }

  private async changed(): Promise<void> {
    await new Promise<void>((resolve) => {
      const before = this.wake;
      this.wake = () => {
        before();
        resolve();
      };
    });
  }

  async run(): Promise<void> {
    const before = new Set(containers());
    let interrupts = 0;
    const { finished } = guard(
      () => [...this.running].map(([issue, step]) => ({ logs: logsFor(issue), step })),
      (signal) => {
        interrupts++;
        if (interrupts === 1) {
          this.tui.activity("\u001B[33mStopping\u001B[0m: removing the containers. Ctrl-C again to force quit.");
          this.stop.abort(new Error(`Interrupted (${signal})`));
          return;
        }
        const ours = containers().filter((id) => !before.has(id));
        if (ours.length > 0) Bun.spawnSync(["docker", "rm", "-f", ...ours]);
        this.tui.close([`Force quit. Removed ${ours.length} container(s).`, ...this.report()]);
        process.exit(130);
      },
    );
    const total = this.bugs.length + this.others.length;
    await Promise.all(Array.from({ length: Math.min(this.workers, total) }, async () => this.worker()));
    finished();
    this.tui.close([...this.report(), "", ...usageReport(this.runs)]);
    if (this.stop.signal.aborted) process.exitCode = 130;
    else if ([...this.results.values()].some((result) => result.startsWith("Failed"))) process.exitCode = 1;
  }

  // Workers start their containers one at a time: creating git worktrees in the same repo at once
  // can trip over git's lock files.
  readonly serialize = async <T>(work: () => Promise<T>): Promise<T> => {
    const turn = this.setups.then(work);
    this.setups = turn.catch(() => null);
    const result = await turn;
    return result;
  };

  // Each worker takes the next bug if no bug is running, otherwise the next other issue whose
  // blockers have published. A worker with only a busy bug lane left stops; the worker holding the
  // lane carries on through the bugs. One with only issues waiting on running blockers waits.
  private async worker(): Promise<void> {
    if (this.stop.signal.aborted) return;
    const bug = this.bugRunning ? undefined : await takeUnblocked(this.bugs, openBlockers, this.bugBlockers);
    if (bug !== undefined) {
      this.bugRunning = true;
      await this.runOne(bug, true);
      this.bugRunning = false;
      return this.worker();
    }
    const next = nextIssue(this.others, this.blockedBy, this.status);
    for (const { issue, reason } of next.skip) {
      this.others.splice(this.others.indexOf(issue), 1);
      this.skip(issue, reason);
    }
    if (next.start !== undefined) {
      this.others.splice(this.others.indexOf(next.start), 1);
      await this.runOne(next.start, false);
      return this.worker();
    }
    if (this.others.length === 0) return;
    // Something waits on a blocker still running or queued in the bug lane; a skip above may also
    // have freed something, so look again before waiting.
    if (next.skip.length > 0) return this.worker();
    const busy = [...this.status.values()].some((status) => status === "running") || this.bugs.length > 0;
    if (!busy) {
      for (const issue of [...this.others]) this.skip(issue, "blocked by an issue in this batch that never ran");
      this.others.length = 0;
      return;
    }
    await this.changed();
    return this.worker();
  }

  private async runOne(issue: string, bug: boolean): Promise<void> {
    const { tui } = this;
    const reporter = tui.reporter(issue);
    const at = (step: string): void => {
      this.running.set(issue, step);
    };
    at("setup");
    this.status.set(issue, "running");
    let status: Status = "failed";
    try {
      // A bug builds on every bug merged before it, so it is cut from the latest origin/main.
      const progress = await runIssue({
        config: this.config,
        issue,
        ...(bug ? { base: "origin/main" } : {}),
        fresh: this.fresh,
        reporter,
        signal: this.stop.signal,
        serialize: this.serialize,
        runs: this.runs,
        onStep: at,
      });
      const { url = "" } = progress;
      status = progress.commented === true ? "commented" : "published";
      if (!bug || progress.commented === true || progress.green !== true) {
        tui.set(issue, "done", "publish", outcome(progress));
        this.results.set(issue, `${outcome(progress)}: ${url}`);
        return;
      }
      at("merge");
      const review = Bun.file(`${logsFor(issue)}/out/pipeline/review.md`);
      const held = (await review.exists()) ? holdReason(await review.text()) : null;
      const left = held ?? (await this.land(issue, url, reporter));
      if (left === null) {
        tui.set(issue, "done", "merge", "merged");
        this.results.set(issue, `Merged: ${url}`);
      } else {
        tui.set(issue, "failed", "merge", `${left}; PR left open`);
        this.results.set(issue, `PR left open, ${left}: ${url}`);
      }
    } catch (error) {
      // runIssue (and resolveConflicts) have written the error and its stack to error.log.
      const current = this.running.get(issue) ?? "setup";
      if (error instanceof Skip) {
        tui.set(issue, "stopped", current, `skipped: ${error.message}`);
        this.results.set(issue, `Skipped: ${error.message}`);
      } else if (this.stop.signal.aborted) {
        tui.set(issue, "stopped", current, "stopped (Ctrl-C)");
        this.results.set(issue, `Stopped during ${current}`);
      } else {
        tui.set(issue, "failed", current, brief(error));
        this.results.set(issue, `Failed during ${current}: ${describe(error)}`);
      }
    } finally {
      this.running.delete(issue);
      this.settle(issue, status);
    }
  }

  // Merges a bug's green PR once CI passes; null when merged, otherwise why it was left open.
  // Main can move on while a bug runs (the owner merges something), so the PR can come to conflict
  // with it; then an agent merges main in, and CI runs again, up to MAX_SYNCS times.
  private async land(issue: string, url: string, reporter: Reporter, syncs = 0): Promise<string | null> {
    const { tui } = this;
    const state = async (field: string): Promise<string> =>
      (await $`gh pr view ${url} --json ${field} --jq .${field}`.quiet().text()).trim();
    if ((await state("state")) === "MERGED") return null;
    // CI runs on this commit; the merge is refused if the branch has moved on since.
    const head = await state("headRefOid");
    // GitHub works out mergeable lazily and can say UNKNOWN for a long time, so git decides too:
    // before waiting, and again if CI never starts or never finishes.
    const early = await this.conflictsWithMain(issue);
    tui.set(
      issue,
      "running",
      "merge",
      syncs === 0 ? "waiting for CI" : `waiting for CI, after merging main (${syncs})`,
    );
    const ci = early ? "conflicting" : await this.waitForCi(url);
    if (this.stop.signal.aborted) throw new Error("Interrupted");
    const stalled = ci === "never started" || ci === "timed out";
    if (ci === "conflicting" || (stalled && (await this.conflictsWithMain(issue)))) {
      if (syncs >= MAX_SYNCS) return `still conflicts with main after ${MAX_SYNCS} merge(s)`;
      tui.set(issue, "running", "merge", "conflicts with main: merging it in (Opus)");
      await resolveConflicts({
        config: this.config,
        issue,
        reporter,
        signal: this.stop.signal,
        serialize: this.serialize,
        runs: this.runs,
      });
      return this.land(issue, url, reporter, syncs + 1);
    }
    if (ci !== "passed") return `CI ${ci}`;
    tui.set(issue, "running", "merge", "gh pr merge --squash");
    const merge = await $`gh pr merge ${url} --squash --delete-branch --match-head-commit ${head}`.nothrow().quiet();
    // gh can merge and then fail to delete the local branch (say, a kept worktree still has it),
    // so the PR's state decides, not the exit code. A merge refused because main moved during CI
    // goes round again, and the next poll finds the conflict.
    if (merge.exitCode === 0 || (await state("state")) === "MERGED") return null;
    if ((await state("mergeable")) === "CONFLICTING") return this.land(issue, url, reporter, syncs);
    return `merge refused (${merge.stderr.toString().trim()})`;
  }

  // Polls the PR until its CI finishes on the head commit. Every poll also reads whether the PR
  // conflicts with main, because GitHub runs no CI on a conflicting PR: it would wait forever.
  private async waitForCi(url: string, started = Date.now()): Promise<CiResult> {
    if (this.stop.signal.aborted) return "failed";
    const view: unknown = await $`gh pr view ${url} --json mergeable,statusCheckRollup`.quiet().json();
    const { mergeable, checks } = prChecks(view);
    if (mergeable === "CONFLICTING") return "conflicting";
    const waited = Date.now() - started;
    if (checks.includes("failed")) return "failed";
    if (checks.length > 0 && checks.every((check) => check === "passed")) return "passed";
    // A PR opened a moment ago may have no checks yet, and GitHub may still be working out mergeable.
    if (checks.length === 0 && waited > CI_START_MS) return "never started";
    if (waited > CI_TIMEOUT_MS) return "timed out";
    await Bun.sleep(CI_POLL_MS);
    return this.waitForCi(url, started);
  }

  // Whether the issue's pushed branch conflicts with the latest main, by a trial merge in git.
  private async conflictsWithMain(issue: string): Promise<boolean> {
    const branch = this.config.branch(issue);
    await $`git fetch -q origin main ${branch}`.quiet();
    const trial = await $`git merge-tree --write-tree origin/main origin/${branch}`.nothrow().quiet();
    // 1 is a conflict; anything else non-zero is git failing, which must not pass for one.
    if (trial.exitCode > 1) throw new Error(`git merge-tree failed: ${trial.stderr.toString().trim()}`);
    return trial.exitCode === 1;
  }

  report(): string[] {
    return [
      ...[...this.results].map(([issue, result]) => `#${issue}  ${result}  (logs: ${logsFor(issue)}/)`),
      ...(this.skipped.length > 0 ? [`Skipped: ${this.skipped.join(", ")}`] : []),
      ...[...this.bugs, ...this.others].map((issue) => {
        if (this.stop.signal.aborted) return `#${issue}  Not started: interrupted`;
        const blockers = this.bugBlockers.get(issue) ?? this.blockedBy.get(issue) ?? [];
        return `#${issue}  Not started: blocked by ${blockers.map((n) => `#${n}`).join(", ") || "an open issue"}`;
      }),
    ];
  }
}

type CiResult = "passed" | "failed" | "conflicting" | "never started" | "timed out";

interface Issue {
  number: number;
  state: string;
  labels: { name: string }[];
  body?: string;
}

// mergeable is MERGEABLE, CONFLICTING or UNKNOWN; each check run or commit status is pending, passed or failed.
function prChecks(view: unknown): { mergeable: string; checks: ("pending" | "passed" | "failed")[] } {
  if (typeof view !== "object" || view === null) return { mergeable: "UNKNOWN", checks: [] };
  const mergeable = "mergeable" in view && typeof view.mergeable === "string" ? view.mergeable : "UNKNOWN";
  const rollup = "statusCheckRollup" in view && Array.isArray(view.statusCheckRollup) ? view.statusCheckRollup : [];
  const checks = rollup.map((check: unknown) => {
    const field = (key: string): string => {
      const value: unknown = typeof check === "object" && check !== null ? Reflect.get(check, key) : undefined;
      return typeof value === "string" ? value : "";
    };
    // A check run has status and conclusion; a commit status has state.
    const state = field("state");
    if (state !== "")
      return state === "SUCCESS" ? "passed" : state === "PENDING" || state === "EXPECTED" ? "pending" : "failed";
    if (field("status") !== "COMPLETED") return "pending";
    return ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(field("conclusion")) ? "passed" : "failed";
  });
  return { mergeable, checks };
}

/** Splits issues into those to run and the rest, each skipped one as `#n (why)`. */
export function triage(issues: Issue[], skipLabels: string[]): { ready: Issue[]; skipped: string[] } {
  const ready: Issue[] = [];
  const skipped: string[] = [];
  for (const issue of issues) {
    const names = issue.labels.map(({ name }) => name);
    const owner = names.filter((name) => skipLabels.includes(name));
    if (issue.state !== "OPEN" || !names.includes(READY)) skipped.push(`#${issue.number} (not open and ${READY})`);
    else if (owner.length > 0) skipped.push(`#${issue.number} (${owner.join(", ")})`);
    else ready.push(issue);
  }
  return { ready, skipped };
}

/** Removes and returns the first issue in `queue` with no open blocker, if there is one; blockers found are recorded in `found`. */
export async function takeUnblocked(
  queue: string[],
  blockers: (issue: string) => Promise<number[]>,
  found = new Map<string, number[]>(),
): Promise<string | undefined> {
  for (const [i, issue] of queue.entries()) {
    const open = await blockers(issue);
    found.set(issue, open);
    if (open.length === 0) return queue.splice(i, 1)[0];
  }
  return undefined;
}

// The open issues that block this one, from GitHub's issue dependencies.
async function openBlockers(issue: string): Promise<number[]> {
  const result =
    await $`gh api repos/{owner}/{repo}/issues/${issue}/dependencies/blocked_by --jq ${'.[] | select(.state == "open") | .number'}`
      .nothrow()
      .quiet();
  if (result.exitCode !== 0) {
    console.warn(`Could not read blockers of #${issue}, treating it as unblocked: ${result.stderr.toString().trim()}`);
    return [];
  }
  return result
    .text()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(Number);
}

/**
 * Why a bug's review report keeps its PR open for the owner rather than merged, or null: a won't-fix
 * finding under `## Spec` (part of the issue left undone) or any `Owner decision:` note.
 */
export function holdReason(review: string): string | null {
  if (/Owner decision:/u.test(review)) return "review has an owner decision";
  const spec = /^## Spec\b([\s\S]*?)(?=^## |$(?![\s\S]))/mu.exec(review)?.[1] ?? "";
  if (/won['’]t fix/iu.test(spec)) return "review has a won't-fix spec finding";
  return null;
}

/** `12` → [12]; `10-20` → [10, 11, …, 20]. */
export function expand(arg: string): number[] {
  const range = /^(\d+)-(\d+)$/u.exec(arg);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (from > to) throw new Error(`Range ${arg} runs backwards.`);
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }
  if (/^\d+$/u.test(arg)) return [Number(arg)];
  throw new Error(`Not an issue number or range: ${arg}. Use e.g. 12 or 10-20.`);
}

function isIssue(value: unknown): value is Issue {
  if (typeof value !== "object" || value === null) return false;
  if (!("number" in value) || !("state" in value) || !("labels" in value)) return false;
  const { number, state, labels } = value;
  return (
    typeof number === "number" &&
    typeof state === "string" &&
    Array.isArray(labels) &&
    labels.every((label: unknown) => typeof label === "object" && label !== null && "name" in label)
  );
}
