import type { Progress } from "./pipeline.ts";

// The gate between the PR body and publish: built-in rules plus the repo's own `gates` that the run's own outputs must keep. A run
// that breaks one stops without publishing, and its rerun goes back to fix with the failures.

/** What a run left behind, read from the worktree and `gh`. */
export interface RunArtefacts {
  issue: { number: number };
  /** out/pipeline/review.md */
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
  issueExists: (issue: number) => boolean;
}

export interface GateFailure {
  rule: string;
  message: string;
}

const ISSUE = /#(\d+)\b/gu;
export const issuesIn = (text: string): number[] => [...text.matchAll(ISSUE)].map((match) => Number(match[1]));

/** The lines under the `## <heading>` section of a Markdown document, up to the next `## `. */
function section(markdown: string, heading: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return end === -1 ? rest : rest.slice(0, end);
}

// A won't-fix spec finding must name an issue that exists, unless the finding itself is wrong.
function wontFixIssue({ review, issueExists }: RunArtefacts): GateFailure[] {
  return section(review, "Spec").flatMap((line) => {
    const verdict = /won['’]t fix:?\s*(.*)/iu.exec(line);
    if (verdict === null) return [];
    if (/^wrong\b/iu.test(verdict[1] ?? "")) return [];
    const named = issuesIn(line);
    const missing = named.filter((issue) => !issueExists(issue));
    if (named.length === 0) return [{ rule: "wont-fix-issue", message: `names no issue: ${line.trim()}` }];
    return missing.map((issue) => ({ rule: "wont-fix-issue", message: `#${issue} does not exist: ${line.trim()}` }));
  });
}

// Each `## Follow-ups` entry links the issue it belongs to.
function followUpLink({ prBody }: RunArtefacts): GateFailure[] {
  return section(prBody, "Follow-ups")
    .filter((line) => /^\s*(?:[-*+]|\d+\.)\s/u.test(line))
    .filter((line) => issuesIn(line).length === 0 && !/\/issues\/\d+/u.test(line))
    .map((line) => ({ rule: "follow-up-link", message: `links no issue: ${line.trim()}` }));
}

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

// The branch holds only this issue's commits.
function foreignCommit({ commits, issue }: RunArtefacts): GateFailure[] {
  return commits
    .filter((subject) => issuesIn(subject).some((named) => named !== issue.number))
    .map((subject) => ({ rule: "foreign-commit", message: `names another issue: ${subject}` }));
}

const RULES = [prSpec, wontFixIssue, followUpLink, evidence, foreignCommit];

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

/** The steps a gate failure undoes, so the rerun starts at fix with gate.md as its task. */
export function rewind(progress: Progress): Progress {
  const { green: _green, ...rest } = progress;
  const undone = new Set(["fix", "check", "pr", "gate"]);
  return { ...rest, done: progress.done.filter((step) => !undone.has(step)), gated: true };
}
