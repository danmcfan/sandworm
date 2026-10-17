import type { Progress } from "./pipeline.ts";

// The gate between the PR body and publish: built-in rules plus the repo's own `gates` that the run's own outputs must keep. A run
// that breaks one stops without publishing, and its rerun goes back to fix with the failures.

/** What a run left behind, read from the worktree and `gh`. */
export interface RunArtefacts {
  /** `parents`: the issues closed by the PRs the branch is or was stacked on; its commits may name them. */
  issue: { number: number; parents?: number[] };
  /** out/pipeline/review.md, for repo rules; no built-in rule reads it. */
  review: string;
  /** out/pipeline/pr-body.md */
  prBody: string;
  /** out/pipeline/pr.json, or null when it is missing or malformed. */
  pr: { title: string; attach: string[] } | null;
  /** Subjects of the commits reachable from the branch but not from the compare base. */
  commits: string[];
  /** The evidence directory, from the repo root, e.g. "out/verify". */
  evidenceDir: string;
  /** Every file under the evidence directory, from the repo root. */
  evidence: string[];
  /** The run's worktree, absolute, so a rule can read the files the other fields name. */
  worktree: string;
  /** Files the branch changes against the compare base, from the repo root. */
  changed: string[];
}

export interface GateFailure {
  rule: string;
  message: string;
}

const ISSUE = /#(\d+)\b/gu;
const issuesIn = (text: string): number[] => [...text.matchAll(ISSUE)].map((match) => Number(match[1]));

// Every evidence path in the body is on disk and attached, and every attachment is on disk.
function evidence({ prBody, pr, evidenceDir, evidence: files }: RunArtefacts): GateFailure[] {
  if (pr === null) return [];
  const escaped = evidenceDir.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const cited = [...prBody.matchAll(new RegExp(`\\./(${escaped}/[^\\s)"'\\]]+)`, "gu"))].map((match) => match[1] ?? "");
  const onDisk = new Set(files);
  return [
    ...cited.filter((path) => !onDisk.has(path)).map((path) => `./${path} is in the body but not on disk`),
    ...cited.filter((path) => !pr.attach.includes(path)).map((path) => `./${path} is in the body but not in attach`),
    ...pr.attach.filter((path) => !onDisk.has(path)).map((path) => `${path} is in attach but not on disk`),
  ].map((message) => ({ rule: "evidence", message }));
}

// pr.json exists and has a title and an attach list, so publish can read it.
function prSpec({ pr }: RunArtefacts): GateFailure[] {
  return pr === null
    ? [{ rule: "pr-json", message: 'pr.json is missing or not {"title": string, "attach": string[]}' }]
    : [];
}

// The branch holds only this issue's commits. A stacked branch's may name its parents' issues too.
function foreignCommit({ commits, issue }: RunArtefacts): GateFailure[] {
  const own = new Set([issue.number, ...(issue.parents ?? [])]);
  return commits
    .filter((subject) => issuesIn(subject).some((named) => !own.has(named)))
    .map((subject) => ({ rule: "foreign-commit", message: `names another issue: ${subject}` }));
}

const RULES = [prSpec, evidence, foreignCommit];

/** A gate rule: the failures it finds in the run's outputs. A repo adds its own through `gates`. */
export type GateRule = (artefacts: RunArtefacts) => GateFailure[] | Promise<GateFailure[]>;

/** Every rule the run's outputs break, built-in then the repo's own; none means it may publish. */
export async function gate(artefacts: RunArtefacts, repoRules: GateRule[] = []): Promise<GateFailure[]> {
  const failures = RULES.flatMap((rule) => rule(artefacts));
  for (const [i, rule] of repoRules.entries()) {
    try {
      failures.push(...(await rule(artefacts)));
    } catch (err) {
      failures.push({ rule: "repo-rule", message: `rule ${i} threw: ${err}` });
    }
  }
  return failures;
}

/** gate.md and error.log: one failure per line, with the rule it broke. */
export const report = (failures: GateFailure[]): string =>
  failures.map(({ rule, message }) => `- ${rule}: ${message}`).join("\n");

/** The steps a gate failure undoes, so fix runs again with gate.md as its task. */
export function rewind(progress: Progress): Progress {
  const { green: _green, ...rest } = progress;
  const undone = new Set(["fix", "check", "pr", "gate"]);
  return { ...rest, done: progress.done.filter((step) => !undone.has(step)), gated: true };
}
