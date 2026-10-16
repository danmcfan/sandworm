import { $ } from "bun";
import type { Resolved } from "./config.ts";

// Stacking: building an issue's branch on another issue's open PR instead of on main, so work that
// needs unmerged work (a blocked-by link) or would conflict with it (an open PR touching the same
// files) does not wait for the owner to merge. The PR targets its parent's branch and shows only
// this issue's diff; GitHub retargets it to main when the parent merges, and a rerun restacks it.
// The words are in GLOSSARY.md; why branches are rebased before the push and merged after is in
// docs/adr/0001-rebase-before-push-merge-after.md.

export const BUG = "bug";

/** The open PR a branch is stacked on, kept in state.json. */
export interface Parent {
  /** The issue the parent PR closes, or "" when it closes none (a conflict with an untracked PR). */
  issue: string;
  branch: string;
  /** The PR's number. */
  pr: string;
  /** The parent's tip when this branch was cut from it or last took in its commits. */
  sha: string;
}

/** An open PR a branch may stack on. */
export interface Pr {
  /** The issue it closes, if known. */
  issue?: string;
  number: string;
  branch: string;
}

/** Thrown when an issue cannot run yet because of its blockers; the message says why. */
export class Skip extends Error {}

/** Under mergeBugs a bug is merged into main on its own, so it never stacks or is stacked on by conflict. */
export function exempt(config: Resolved, labels: { name: string }[]): boolean {
  return config.mergeBugs && labels.some(({ name }) => name === BUG);
}

export interface Blocker {
  issue: string;
  open: boolean;
  /** The blocker's open PR, if it has one. */
  pr?: { number: string; branch: string };
}

export type Blockers =
  | { kind: "none" }
  | { kind: "wait"; on: string[] }
  | { kind: "skip"; reason: string }
  | { kind: "candidates"; prs: (Pr & { issue: string })[] };

/**
 * What an issue's blockers mean for it. A closed blocker is done with; an open one with a PR is a
 * parent candidate; one with no PR is waited for if it is in the batch, and otherwise means the
 * issue cannot start, since it would build without work it needs.
 */
export function resolveBlockers(blockers: Blocker[], inBatch: ReadonlySet<string>): Blockers {
  const open = blockers.filter(({ open }) => open);
  const missing = open.filter(({ pr, issue }) => pr === undefined && !inBatch.has(issue));
  if (missing.length > 0) {
    const which = missing.map(({ issue }) => `#${issue}`).join(", ");
    return { kind: "skip", reason: `blocked by ${which}, which has no open PR to stack on` };
  }
  const waiting = open.filter(({ pr }) => pr === undefined).map(({ issue }) => issue);
  if (waiting.length > 0) return { kind: "wait", on: waiting };
  const prs = open.flatMap(({ issue, pr }) => (pr === undefined ? [] : [{ issue, ...pr }]));
  return prs.length === 0 ? { kind: "none" } : { kind: "candidates", prs };
}

/** Whether `ancestor` is in `descendant`'s history (a branch counts as its own ancestor). */
export type IsAncestor = (ancestor: string, descendant: string) => Promise<boolean>;

/** The branch every other branch is an ancestor of, if they form one chain; otherwise undefined. */
export async function chainTip(branches: string[], isAncestor: IsAncestor): Promise<string | undefined> {
  for (const tip of branches) {
    const under = await Promise.all(branches.map(async (other) => isAncestor(other, tip)));
    if (under.every(Boolean)) return tip;
  }
  return undefined;
}

/**
 * The order to run a batch in: each issue after its in-batch blockers, and otherwise in the given
 * (oldest first) order. An issue in a dependency cycle, or waiting on one, can never start, so it is
 * left out and listed under `cycles`. Blockers outside the batch are the pipeline's to deal with.
 */
export function order(
  issues: string[],
  blockedBy: ReadonlyMap<string, string[]>,
): { order: string[]; cycles: string[] } {
  const inBatch = new Set(issues);
  const placed: string[] = [];
  const done = new Set<string>();
  const bad = new Set<string>();
  const visiting = new Set<string>();
  const visit = (issue: string): boolean => {
    if (done.has(issue)) return true;
    if (bad.has(issue) || visiting.has(issue)) return false;
    visiting.add(issue);
    const ok = (blockedBy.get(issue) ?? []).filter((b) => inBatch.has(b)).every((b) => visit(b));
    visiting.delete(issue);
    if (!ok) {
      bad.add(issue);
      return false;
    }
    done.add(issue);
    placed.push(issue);
    return true;
  };
  for (const issue of issues) visit(issue);
  return { order: placed, cycles: issues.filter((issue) => bad.has(issue)) };
}

/** Where a batch issue is: running, published (has a PR to stack on), or failed, stopped or skipped. */
export type Status = "running" | "published" | "failed";

/**
 * The next issue in `queue` that may start: the first whose in-batch blockers have all published.
 * Their PRs need not be merged, since the issue stacks on them. A blocker that failed means its
 * dependents can never start, so they are returned under `skip` (the caller marks them failed, which
 * skips their own dependents in turn). The batch is `queue` plus every issue with a status.
 */
export function nextIssue(
  queue: string[],
  blockedBy: ReadonlyMap<string, string[]>,
  status: ReadonlyMap<string, Status>,
): { start?: string; skip: { issue: string; reason: string }[] } {
  const queued = new Set(queue);
  const skip: { issue: string; reason: string }[] = [];
  for (const issue of queue) {
    const blockers = (blockedBy.get(issue) ?? []).filter((b) => queued.has(b) || status.has(b));
    const failed = blockers.find((b) => status.get(b) === "failed");
    if (failed !== undefined) skip.push({ issue, reason: `blocker #${failed} did not publish` });
    else if (blockers.every((b) => status.get(b) === "published")) return { start: issue, skip };
  }
  return { skip };
}

/**
 * Which conflicting PR to stack on. PRs on one chain are stacked on at the tip, which holds them
 * all. Unrelated ones cannot all be parents, so the one with the most conflicting files wins (the
 * owner's call: it leaves the least to resolve when the others merge); the rest are `others`, for
 * the PR body to name.
 */
export async function pickConflict(
  conflicts: { pr: Pr; files: string[] }[],
  isAncestor: IsAncestor,
): Promise<{ target: Pr; others: Pr[] } | undefined> {
  const tip = await chainTip(
    conflicts.map(({ pr }) => pr.branch),
    isAncestor,
  );
  const chained = conflicts.find(({ pr }) => pr.branch === tip);
  if (chained !== undefined) return { target: chained.pr, others: [] };
  const most = conflicts.reduce<{ pr: Pr; files: string[] } | undefined>(
    (best, next) => (best === undefined || next.files.length > best.files.length ? next : best),
    undefined,
  );
  if (most === undefined) return undefined;
  return { target: most.pr, others: conflicts.filter((c) => c !== most).map(({ pr }) => pr) };
}

/** The files a merge of `theirs` into `ours` conflicts on, by a trial merge that touches no checkout. */
export async function conflictingFiles(cwd: string, ours: string, theirs: string): Promise<string[]> {
  const trial = await $`git merge-tree --write-tree --name-only --no-messages ${ours} ${theirs}`
    .cwd(cwd)
    .nothrow()
    .quiet();
  // 1 is a conflict; anything else non-zero is git failing, which must not pass for one.
  if (trial.exitCode > 1) throw new Error(`git merge-tree failed: ${trial.stderr.toString().trim()}`);
  if (trial.exitCode === 0) return [];
  // The merged tree's id, then one conflicted file per line.
  return [...new Set(trial.stdout.toString().trim().split("\n").slice(1).filter(Boolean))];
}

/**
 * Moves the checked-out branch's own commits (those not in `upstream`) onto `onto`. False, with the
 * rebase aborted and the branch as it was, if that conflicts; an agent resolves it then (stack.md).
 */
export async function rebaseOnto(cwd: string, onto: string, upstream: string): Promise<boolean> {
  const rebase = await $`git rebase --onto ${onto} ${upstream}`.cwd(cwd).nothrow().quiet();
  if (rebase.exitCode === 0) return true;
  await $`git rebase --abort`.cwd(cwd).nothrow().quiet();
  return false;
}

/** Merges `ref` into the checked-out branch. False, with the merge aborted, if it conflicts. */
export async function mergeIn(cwd: string, ref: string): Promise<boolean> {
  const merge = await $`git -c core.editor=true merge --no-edit ${ref}`.cwd(cwd).nothrow().quiet();
  if (merge.exitCode === 0) return true;
  await $`git merge --abort`.cwd(cwd).nothrow().quiet();
  return false;
}

const isAncestorOnOrigin: IsAncestor = async (ancestor, descendant) =>
  (await $`git merge-base --is-ancestor origin/${ancestor} origin/${descendant}`.nothrow().quiet()).exitCode === 0;

const tipOf = async (ref: string): Promise<string> => (await $`git rev-parse ${ref}`.quiet().text()).trim();

/** An open PR, with what the pipeline needs to match it to issues. */
interface OpenPr extends Pr {
  closes: string[];
  bug: boolean;
}

/** Every open PR. Under mergeBugs, `bug` marks a bug's PR: labelled bug, or closing or named for an open bug. */
export async function openPrs(config: Resolved): Promise<OpenPr[]> {
  const listed: unknown =
    await $`gh pr list --state open --limit 200 --json number,headRefName,closingIssuesReferences,labels`
      .quiet()
      .json();
  const bugs = config.mergeBugs
    ? new Set(
        (await $`gh issue list --label ${BUG} --state open --limit 200 --json number --jq '.[].number'`.quiet().text())
          .split("\n")
          .filter(Boolean),
      )
    : new Set<string>();
  return (Array.isArray(listed) ? listed : []).flatMap((value: unknown): OpenPr[] => {
    if (!isListedPr(value)) return [];
    const closes = value.closingIssuesReferences.map(({ number }) => String(number));
    const named = [...bugs].some((issue) => config.branch(issue) === value.headRefName);
    const bug =
      config.mergeBugs &&
      (value.labels.some(({ name }) => name === BUG) || named || closes.some((issue) => bugs.has(issue)));
    const pr: OpenPr = { number: String(value.number), branch: value.headRefName, closes, bug };
    return [closes[0] === undefined ? pr : { ...pr, issue: closes[0] }];
  });
}

/** The issues GitHub says block `issue` (its native "blocked by" links), with whether each is open. */
export async function blockersOf(issue: string): Promise<{ issue: string; open: boolean }[]> {
  const text =
    await $`gh api --paginate repos/{owner}/{repo}/issues/${issue}/dependencies/blocked_by --jq '.[] | {number, state}'`
      .quiet()
      .text();
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const value: unknown = JSON.parse(line);
      if (typeof value !== "object" || value === null || !("number" in value) || !("state" in value)) return [];
      return [{ issue: String(value.number), open: value.state === "open" }];
    });
}

/**
 * The parent a new branch for `issue` is cut from: the open PR of the issue that blocks it, or the
 * tip of the chain when several do. Undefined when nothing open blocks it. Throws Skip when it cannot
 * start: a blocker has no PR, or the blockers' PRs are not on one chain. The batch waits for blockers
 * it is running before calling this, so here a blocker with no PR is never one to wait for.
 */
export async function findParent(config: Resolved, issue: string): Promise<Parent | undefined> {
  const blockers = await blockersOf(issue);
  if (!blockers.some(({ open }) => open)) return undefined;
  const prs = await openPrs(config);
  const prFor = (blocker: string): OpenPr | undefined =>
    prs.find(({ branch }) => branch === config.branch(blocker)) ?? prs.find(({ closes }) => closes.includes(blocker));
  const found = resolveBlockers(
    blockers.map((b) => {
      const pr = b.open ? prFor(b.issue) : undefined;
      return pr === undefined ? b : { ...b, pr: { number: pr.number, branch: pr.branch } };
    }),
    new Set(),
  );
  if (found.kind === "skip") throw new Skip(found.reason);
  if (found.kind === "wait") throw new Skip(`blocked by ${found.on.map((b) => `#${b}`).join(", ")}, not yet published`);
  if (found.kind === "none") return undefined;
  await $`git fetch -q origin ${found.prs.map(({ branch }) => branch)}`.quiet();
  const tip = await chainTip(
    found.prs.map(({ branch }) => branch),
    isAncestorOnOrigin,
  );
  const parent = found.prs.find(({ branch }) => branch === tip);
  if (parent === undefined) {
    const which = found.prs.map(({ issue: blocker, number }) => `#${blocker} (PR #${number})`).join(", ");
    throw new Skip(`blocked by ${which}, whose branches are not on one chain, so there is no one branch to stack on`);
  }
  return { issue: parent.issue, branch: parent.branch, pr: parent.number, sha: await tipOf(`origin/${parent.branch}`) };
}

/**
 * The open PR the branch checked out in `cwd` should move onto because it conflicts with it, and the
 * other conflicting PRs it could not also stack on. Leaves out the branch's own PR, PRs already in
 * its history (its parent and theirs), and under mergeBugs every bug's PR, since a bug lands on main
 * alone and a branch stacked on it would wait on its merge.
 */
export async function conflictTarget(
  config: Resolved,
  issue: string,
  cwd: string,
): Promise<{ parent: Parent; others: Pr[] } | undefined> {
  const own = config.branch(issue);
  const prs = (await openPrs(config)).filter(({ branch, bug }) => branch !== own && !bug);
  if (prs.length === 0) return undefined;
  await $`git fetch -q origin ${prs.map(({ branch }) => branch)}`.quiet();
  const conflicts: { pr: Pr; files: string[] }[] = [];
  for (const { closes: _closes, bug: _bug, ...pr } of prs) {
    const contained = await $`git merge-base --is-ancestor origin/${pr.branch} HEAD`.cwd(cwd).nothrow().quiet();
    if (contained.exitCode === 0) continue;
    const files = await conflictingFiles(cwd, "HEAD", `origin/${pr.branch}`);
    if (files.length > 0) conflicts.push({ pr, files });
  }
  const pick = await pickConflict(conflicts, isAncestorOnOrigin);
  if (pick === undefined) return undefined;
  const { target } = pick;
  return {
    parent: {
      issue: target.issue ?? "",
      branch: target.branch,
      pr: target.number,
      sha: await tipOf(`origin/${target.branch}`),
    },
    others: pick.others,
  };
}

/** The line a stacked PR's body starts with, so the owner merges in order. */
export function stackNote(parent: Parent, others: string[] = []): string {
  const on = `Stacked on #${parent.pr}${parent.issue === "" ? "" : ` (issue #${parent.issue})`}. Merge that first.`;
  if (others.length === 0) return on;
  const also = others.map((number) => `#${number}`).join(", ");
  return `${on} Also conflicts with ${also}, which will need a merge once one of them lands.`;
}

export function isParent(value: unknown): value is Parent {
  if (typeof value !== "object" || value === null) return false;
  return ["issue", "branch", "pr", "sha"].every((key) => typeof Reflect.get(value, key) === "string");
}

interface ListedPr {
  number: number;
  headRefName: string;
  closingIssuesReferences: { number: number }[];
  labels: { name: string }[];
}

function isListedPr(value: unknown): value is ListedPr {
  if (typeof value !== "object" || value === null) return false;
  if (!("number" in value) || !("headRefName" in value)) return false;
  const refs = "closingIssuesReferences" in value ? value.closingIssuesReferences : undefined;
  const labels = "labels" in value ? value.labels : undefined;
  return (
    typeof value.number === "number" &&
    typeof value.headRefName === "string" &&
    Array.isArray(refs) &&
    refs.every((ref: unknown) => typeof ref === "object" && ref !== null && "number" in ref) &&
    Array.isArray(labels) &&
    labels.every((label: unknown) => typeof label === "object" && label !== null && "name" in label)
  );
}
