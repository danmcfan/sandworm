import { describe as group, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expand, holdReason, takeUnblocked, triage } from "../src/batch.ts";
import { argsFor, promptPath, resolve } from "../src/config.ts";
import { journal } from "../src/journal.ts";
import { gate, rewind, type RunArtefacts } from "../src/gate.ts";

const config = {
  repo: "demo",
  prompts: { verify: "Verify it.", reverify: "Verify it again.", evidence: "out/verify" },
};

group("resolve", () => {
  test("fills in the defaults", () => {
    const resolved = resolve(config);
    expect(resolved.branch("7")).toBe("agent/7");
    expect(resolved.base).toBe("HEAD");
    expect(resolved.compare).toBe("main");
    expect(resolved.keep).toEqual(["out"]);
    expect(resolved.workers).toBe(1);
    expect(resolved.mergeBugs).toBe(false);
    expect(resolved.skipLabels).toEqual(["needs-owner"]);
  });

  test("compares against origin/main when branches are cut from it", () => {
    const resolved = resolve({ ...config, base: "origin/main", branch: (issue) => `issue-${issue}-agent` });
    expect(resolved.args["BASE"]).toBe("origin/main");
    expect(resolved.branch("7")).toBe("issue-7-agent");
  });
});

group("prompts", () => {
  test("every shared prompt has a value for each arg it uses", async () => {
    const dir = join(import.meta.dir, "../prompts");
    // The args the pipeline adds per step, and Sandcastle's own.
    const known = new Set([...Object.keys(resolve(config).args), "ISSUE_NUMBER", "TASK", "CHECK", "TARGET_BRANCH"]);
    for (const name of readdirSync(dir)) {
      const used = [...readFileSync(join(dir, name), "utf8").matchAll(/\{\{\s*(\w+)\s*\}\}/gu)].map((m) => m[1]);
      expect({ name, unknown: used.filter((key) => key !== undefined && !known.has(key)) }).toEqual({
        name,
        unknown: [],
      });
    }
  });

  test("passes a prompt only the args it uses", async () => {
    const args = await argsFor(promptPath("fix.md"), { ...resolve(config).args, ISSUE_NUMBER: "7", TASK: "t" });
    expect(Object.keys(args).sort()).toEqual(["ISSUE_NUMBER", "REPO", "REVERIFY", "TASK"]);
  });
});

test("expand reads numbers and inclusive ranges", () => {
  expect(expand("12")).toEqual([12]);
  expect(expand("3-5")).toEqual([3, 4, 5]);
  expect(() => expand("5-3")).toThrow("backwards");
  expect(() => expand("x")).toThrow("Not an issue number");
});

test("journal writes the step, the error and its stack to error.log and the agent log", () => {
  const logs = mkdtempSync(join(tmpdir(), "sandworm-"));
  const agentLog = join(logs, "implement.log");
  journal(logs, "implement", "failed", new Error("container went away"), agentLog);
  for (const file of [join(logs, "error.log"), agentLog]) {
    const text = readFileSync(file, "utf8");
    expect(text).toContain("· implement · failed ---");
    expect(text).toContain("container went away");
    expect(text).toContain("sandworm.test.ts");
  }
});

group("gate", () => {
  const passing: RunArtefacts = {
    issue: { number: 7 },
    review: "## Standards\n\nS1 (should fix): rename it.\n\n## Spec\n\nP1 (won't fix: belongs to #9): add a flag.\n",
    prBody: "Closes #7\n\n![menu](./out/verify/menu.png)\n\n## Follow-ups\n\n- P1: a flag, in #9\n",
    pr: { title: "Menu: add it", attach: ["out/verify/menu.png"] },
    commits: ["Menu: add it (#7)", "Menu: rename it"],
    evidenceDir: "out/verify",
    evidence: ["out/verify/menu.png"],
    issueExists: (issue) => issue === 7 || issue === 9,
  };
  const rules = (artefacts: Partial<RunArtefacts>): string[] =>
    gate({ ...passing, ...artefacts }).map(({ rule }) => rule);

  test("passes a run that keeps every rule", () => {
    expect(gate(passing)).toEqual([]);
  });

  test("fails a won't-fix spec finding that names no issue", () => {
    expect(rules({ review: "## Spec\n\nP1 (won't fix: not worth it): add a flag.\n" })).toEqual(["wont-fix-issue"]);
  });

  test("passes a won't-fix spec finding that is wrong", () => {
    expect(rules({ review: "## Spec\n\nP1 (won't fix: wrong, the flag exists): add a flag.\n" })).toEqual([]);
  });

  test("fails a won't-fix spec finding naming an issue that does not exist", () => {
    expect(rules({ review: "## Spec\n\nP1 (won't fix: belongs to #404): add a flag.\n" })).toEqual(["wont-fix-issue"]);
  });

  test("leaves won't-fix standards findings alone", () => {
    expect(rules({ review: "## Standards\n\nS1 (won't fix: not worth it): rename.\n\n## Spec\n\nNone.\n" })).toEqual(
      [],
    );
  });

  test("fails a follow-up without an issue link", () => {
    expect(rules({ prBody: "Closes #7\n\n## Follow-ups\n\n- P1: a flag, later\n" })).toEqual(["follow-up-link"]);
    expect(rules({ prBody: "Closes #7\n\n## Follow-ups\n\n- P1: https://github.com/a/b/issues/9\n" })).toEqual([]);
  });

  test("fails a body path missing from disk", () => {
    expect(rules({ evidence: [] })).toEqual(["evidence", "evidence"]);
  });

  test("fails a body path missing from attach, and an attach entry missing from disk", () => {
    expect(rules({ pr: { title: "t", attach: [] } })).toEqual(["evidence"]);
    expect(rules({ pr: { title: "t", attach: ["out/verify/menu.png", "out/verify/gone.png"] } })).toEqual(["evidence"]);
  });

  test("fails a commit naming another issue", () => {
    expect(rules({ commits: ["Menu: add it (#7)", "Lobby: fix the timer (#8)"] })).toEqual(["foreign-commit"]);
  });

  test("fails a missing or malformed pr.json", () => {
    expect(rules({ pr: null })).toEqual(["pr-json"]);
  });

  test("a failed gate sends the rerun back to fix", () => {
    const progress = { done: ["feedback", "setup", "implement", "review", "fix", "check", "pr"], green: true };
    expect(rewind(progress)).toEqual({ done: ["feedback", "setup", "implement", "review"], gated: true });
  });
});

group("issue selection", () => {
  const issue = (number: number, ...labels: string[]) => ({
    number,
    state: "OPEN",
    labels: ["ready-for-agent", ...labels].map((name) => ({ name })),
  });

  test("skips issues carrying a skipLabels label, and closed or unready ones", () => {
    const closed = { ...issue(4), state: "CLOSED" };
    const { ready, skipped } = triage(
      [issue(1), issue(2, "needs-owner"), issue(3, "art"), closed],
      ["needs-owner", "art"],
    );
    expect(ready.map(({ number }) => number)).toEqual([1]);
    expect(skipped).toEqual(["#2 (needs-owner)", "#3 (art)", "#4 (not open and ready-for-agent)"]);
  });

  test("takes the first queued issue with no open blocker, and a blocked one once its blocker closes", async () => {
    const open = new Set([1]);
    const blockers: Record<string, number[]> = { "5": [1], "6": [] };
    const openBlockers = async (n: string) => (blockers[n] ?? []).filter((b) => open.has(b));
    const queue = ["5", "6"];
    expect(await takeUnblocked(queue, openBlockers)).toBe("6");
    expect(await takeUnblocked(queue, openBlockers)).toBeUndefined();
    expect(queue).toEqual(["5"]);
    open.delete(1);
    expect(await takeUnblocked(queue, openBlockers)).toBe("5");
    expect(queue).toEqual([]);
  });

  test("records the open blockers it finds for each issue", async () => {
    const found = new Map<string, number[]>();
    const queue = ["5", "6"];
    await takeUnblocked(queue, async (n) => (n === "5" ? [1, 2] : []), found);
    expect(found.get("5")).toEqual([1, 2]);
  });
});

group("mergeBugs hold", () => {
  test("a won't-fix spec finding holds the PR open", () => {
    const review = "## Standards\n\nS1 won't fix: style.\n\n## Spec\n\nP1 **won't fix: belongs to #9** src/a.ts:3\n";
    expect(holdReason(review)).toContain("won't-fix spec finding");
  });

  test("an Owner decision: note holds the PR open", () => {
    expect(holdReason("## Spec\n\nP1 should fix. Owner decision: which colour?\n")).toContain("owner decision");
  });

  test("a clean review, or a won't-fix only on standards, merges", () => {
    expect(holdReason("No findings.")).toBeNull();
    expect(holdReason("## Standards\n\nS1 won't fix: style.\n\n## Spec\n\nP1 must fix: x.\n")).toBeNull();
  });
});
