import { describe as group, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expand } from "../src/batch.ts";
import { worktreeHolding } from "../src/pipeline.ts";
import { argsFor, promptPath, resolve } from "../src/config.ts";
import { journal } from "../src/journal.ts";
import {
  chainTip,
  conflictingFiles,
  exempt,
  mergeIn,
  nextIssue,
  order,
  pickConflict,
  rebaseOnto,
  resolveBlockers,
  stackNote,
  withoutStackNote,
} from "../src/stack.ts";
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
    expect(resolved.gates).toEqual([]);
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
    const known = new Set([
      ...Object.keys(resolve(config).args),
      "ISSUE_NUMBER",
      "TASK",
      "CHECK",
      "ONTO",
      "UPSTREAM",
      "TARGET_BRANCH",
    ]);
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

group("stack: blockers", () => {
  const pr = (number: string, branch: string) => ({ number, branch });

  test("closed blockers set no constraint", () => {
    expect(resolveBlockers([{ issue: "3", open: false }], new Set())).toEqual({ kind: "none" });
  });

  test("an open blocker with a PR is a parent candidate", () => {
    const found = resolveBlockers([{ issue: "3", open: true, pr: pr("40", "agent/3") }], new Set());
    expect(found).toEqual({ kind: "candidates", prs: [{ issue: "3", number: "40", branch: "agent/3" }] });
  });

  test("an open blocker in the batch with no PR yet is waited for", () => {
    const found = resolveBlockers(
      [
        { issue: "3", open: true },
        { issue: "4", open: true, pr: pr("41", "agent/4") },
      ],
      new Set(["3"]),
    );
    expect(found).toEqual({ kind: "wait", on: ["3"] });
  });

  test("an open blocker with no PR outside the batch skips the issue", () => {
    const found = resolveBlockers([{ issue: "3", open: true }], new Set(["9"]));
    expect(found.kind).toBe("skip");
    expect(found.kind === "skip" && found.reason).toContain("#3");
  });

  test("the chain tip is the branch every other branch is an ancestor of", async () => {
    // a ← b ← c
    const line = ["a", "b", "c"];
    const ancestor = async (x: string, y: string) => line.indexOf(x) <= line.indexOf(y);
    expect(await chainTip(["b", "c", "a"], ancestor)).toBe("c");
    expect(await chainTip(["a"], ancestor)).toBe("a");
  });

  test("unrelated branches have no chain tip", async () => {
    const ancestor = async (x: string, y: string) => x === y;
    expect(await chainTip(["a", "b"], ancestor)).toBeUndefined();
  });
});

group("stack: batch order", () => {
  test("blockers come before what they block, otherwise the given order holds", () => {
    const blockedBy = new Map([
      ["1", ["3"]],
      ["2", []],
      ["3", []],
    ]);
    expect(order(["1", "2", "3"], blockedBy)).toEqual({ order: ["3", "1", "2"], cycles: [] });
  });

  test("blockers outside the batch are ignored", () => {
    expect(order(["1"], new Map([["1", ["99"]]]))).toEqual({ order: ["1"], cycles: [] });
  });

  test("a cycle, and whatever waits on it, is reported and left out", () => {
    const blockedBy = new Map([
      ["1", ["2"]],
      ["2", ["1"]],
      ["3", ["2"]],
      ["4", []],
    ]);
    expect(order(["1", "2", "3", "4"], blockedBy)).toEqual({ order: ["4"], cycles: ["1", "2", "3"] });
  });

  test("an issue starts once its in-batch blockers have published", () => {
    const blockedBy = new Map([
      ["1", ["3"]],
      ["2", []],
    ]);
    expect(nextIssue(["1", "2", "3"], blockedBy, new Map())).toEqual({ start: "2", skip: [] });
    expect(nextIssue(["1"], blockedBy, new Map([["3", "running"]]))).toEqual({ skip: [] });
    expect(nextIssue(["1"], blockedBy, new Map([["3", "published"]]))).toEqual({ start: "1", skip: [] });
  });

  test("a blocker queued in another lane (a bug) is waited for", () => {
    expect(nextIssue(["1"], new Map([["1", ["7"]]]), new Map([["7", "queued"]]))).toEqual({ skip: [] });
  });

  test("an issue whose blocker published only a comment is skipped, saying so", () => {
    const next = nextIssue(["1"], new Map([["1", ["3"]]]), new Map([["3", "commented"]]));
    expect(next).toEqual({
      skip: [{ issue: "1", reason: "blocker #3 published no PR (it had no commits), so there is nothing to stack on" }],
    });
  });

  test("an issue whose blocker failed is skipped", () => {
    const next = nextIssue(["1", "2"], new Map([["1", ["3"]]]), new Map([["3", "failed"]]));
    expect(next).toEqual({ start: "2", skip: [{ issue: "1", reason: "blocker #3 did not publish" }] });
  });
});

group("stack: conflicts", () => {
  const prs = {
    small: { issue: "5", number: "50", branch: "agent/5" },
    big: { issue: "6", number: "60", branch: "agent/6" },
  };

  test("unrelated conflicting PRs: stack on the one with more conflicting files", async () => {
    const pick = await pickConflict(
      [
        { pr: prs.small, files: ["a.ts"] },
        { pr: prs.big, files: ["a.ts", "b.ts"] },
      ],
      async (x, y) => x === y,
    );
    expect(pick).toEqual({ target: prs.big, others: [prs.small] });
  });

  test("conflicting PRs on one chain: stack on its tip", async () => {
    // agent/6 ← agent/5
    const pick = await pickConflict(
      [
        { pr: prs.small, files: ["a.ts"] },
        { pr: prs.big, files: ["a.ts", "b.ts"] },
      ],
      async (x, y) => x === y || (x === "agent/6" && y === "agent/5"),
    );
    expect(pick).toEqual({ target: prs.small, others: [] });
  });

  test("bugs are exempt from stacking only when mergeBugs is on", () => {
    const labels = [{ name: "bug" }];
    expect(exempt(resolve({ ...config, batch: { mergeBugs: true } }), labels)).toBe(true);
    expect(exempt(resolve(config), labels)).toBe(false);
    expect(exempt(resolve({ ...config, batch: { mergeBugs: true } }), [{ name: "feature" }])).toBe(false);
  });

  test("stacking is on by default and each part can be turned off", () => {
    expect(resolve(config).stack).toEqual({ blockers: true, conflicts: true });
    expect(resolve({ ...config, stack: { conflicts: false } }).stack).toEqual({ blockers: true, conflicts: false });
  });
});

group("stack: git", () => {
  // main: a.txt=1; feature A changes a.txt and adds x.txt; child B branches from A and adds b.txt.
  const repo = (): { git: (...args: string[]) => string; dir: string } => {
    const dir = mkdtempSync(join(tmpdir(), "sandworm-git-"));
    const git = (...args: string[]): string => {
      const run = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
      if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
      return run.stdout.toString().trim();
    };
    const write = (file: string, text: string): void => {
      writeFileSync(join(dir, file), text);
      git("add", file);
    };
    git("init", "-q", "-b", "main");
    write("a.txt", "1\n");
    git("commit", "-qm", "base");
    git("switch", "-qc", "A");
    write("a.txt", "A\n");
    write("x.txt", "x\n");
    git("commit", "-qm", "A");
    git("switch", "-qc", "B");
    write("b.txt", "b\n");
    git("commit", "-qm", "B");
    git("switch", "-q", "main");
    return { git, dir };
  };

  test("conflictingFiles names the files a trial merge conflicts on, and leaves the checkout alone", async () => {
    const { git, dir } = repo();
    git("switch", "-qc", "C", "main");
    writeFileSync(join(dir, "a.txt"), "C\n");
    git("commit", "-qam", "C");
    expect(await conflictingFiles(dir, "C", "A")).toEqual(["a.txt"]);
    expect(await conflictingFiles(dir, "B", "A")).toEqual([]);
    expect(git("status", "--porcelain")).toBe("");
  });

  test("rebaseOnto moves only the child's commits, as after the parent is squash-merged", async () => {
    const { git, dir } = repo();
    const parentSha = git("rev-parse", "A");
    // The parent lands on main as one squashed commit.
    git("merge", "-q", "--squash", "A");
    git("commit", "-qm", "A (squashed)");
    git("switch", "-q", "B");
    expect(await rebaseOnto(dir, "main", parentSha)).toBe(true);
    expect(git("log", "--format=%s", "main..B")).toBe("B");
    expect(git("show", "B:a.txt")).toBe("A");
  });

  test("rebaseOnto aborts and reports a conflict, leaving the branch as it was", async () => {
    const { git, dir } = repo();
    git("switch", "-qc", "C", "main");
    writeFileSync(join(dir, "b.txt"), "c\n");
    git("add", "b.txt");
    git("commit", "-qm", "C");
    git("switch", "-q", "B");
    const before = git("rev-parse", "B");
    expect(await rebaseOnto(dir, "C", "A")).toBe(false);
    expect(git("rev-parse", "B")).toBe(before);
    expect(git("status", "--porcelain")).toBe("");
  });

  test("mergeIn takes in a parent's new commits, and aborts cleanly on a conflict", async () => {
    const { git, dir } = repo();
    git("switch", "-q", "A");
    writeFileSync(join(dir, "y.txt"), "y\n");
    git("add", "y.txt");
    git("commit", "-qm", "A2");
    git("switch", "-q", "B");
    expect(await mergeIn(dir, "A")).toBe(true);
    expect(git("show", "B:y.txt")).toBe("y");

    git("switch", "-q", "A");
    writeFileSync(join(dir, "b.txt"), "from A\n");
    git("add", "b.txt");
    git("commit", "-qm", "A3");
    git("switch", "-q", "B");
    const before = git("rev-parse", "B");
    expect(await mergeIn(dir, "A")).toBe(false);
    expect(git("rev-parse", "B")).toBe(before);
    expect(git("status", "--porcelain")).toBe("");
  });
});

test("stackNote names the parent first, and any other PR the branch conflicts with", () => {
  const parent = { issue: "3", branch: "agent/3", pr: "40", sha: "abc" };
  expect(stackNote(parent)).toBe("Stacked on #40 (issue #3). Merge that first.");
  expect(stackNote({ ...parent, issue: "" }, ["41"])).toBe(
    "Stacked on #40. Merge that first. Also conflicts with #41, which will need a merge once one of them lands.",
  );
});

test("worktreeHolding finds the worktree a branch is checked out in", () => {
  const porcelain = [
    "worktree /repo",
    "HEAD aaa",
    "branch refs/heads/main",
    "",
    "worktree /repo/.sandcastle/worktrees/agent-3",
    "HEAD bbb",
    "branch refs/heads/agent/3",
    "",
  ].join("\n");
  expect(worktreeHolding(porcelain, "agent/3")).toBe("/repo/.sandcastle/worktrees/agent-3");
  expect(worktreeHolding(porcelain, "agent/30")).toBeUndefined();
});

test("withoutStackNote removes the stacking line a PR body starts with, and nothing else", () => {
  const note = stackNote({ issue: "3", branch: "agent/3", pr: "40", sha: "abc" });
  expect(withoutStackNote(`${note}\n\nCloses #4\n\nStacked on #9 in prose.`)).toBe(
    "Closes #4\n\nStacked on #9 in prose.",
  );
  expect(withoutStackNote("Closes #4")).toBe("Closes #4");
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
  const rules = async (artefacts: Partial<RunArtefacts>): Promise<string[]> =>
    (await gate({ ...passing, ...artefacts })).map(({ rule }) => rule);

  test("passes a run that keeps every rule", async () => {
    expect(await gate(passing)).toEqual([]);
  });

  test("runs the repo's rules after the built-in ones, sync and async, and fails on theirs", async () => {
    const seen: RunArtefacts[] = [];
    const { gates } = resolve({
      ...config,
      gates: [
        (artefacts) => {
          seen.push(artefacts);
          return [{ rule: "screenshot", message: "no menu screenshot" }];
        },
        async () => [{ rule: "parity-trace", message: "trace differs" }],
      ],
    });
    const failures = await gate({ ...passing, commits: ["Lobby: fix it (#8)"] }, gates);
    expect(failures.map(({ rule }) => rule)).toEqual(["foreign-commit", "screenshot", "parity-trace"]);
    expect(failures[1]).toEqual({ rule: "screenshot", message: "no menu screenshot" });
    expect(seen[0]?.issue.number).toBe(7);
    expect(await gate(passing, [() => []])).toEqual([]);
  });

  test("turns a throwing repo rule into a failure", async () => {
    const failures = await gate(passing, [
      () => {
        throw new Error("boom");
      },
      async () => Promise.reject(new Error("nope")),
    ]);
    expect(failures.map(({ rule }) => rule)).toEqual(["repo-rule", "repo-rule"]);
    expect(failures[0]?.message).toContain("rule 0 threw");
    expect(failures[1]?.message).toContain("nope");
  });

  test("fails a won't-fix spec finding that names no issue", async () => {
    expect(await rules({ review: "## Spec\n\nP1 (won't fix: not worth it): add a flag.\n" })).toEqual([
      "wont-fix-issue",
    ]);
  });

  test("passes a won't-fix spec finding that is wrong", async () => {
    expect(await rules({ review: "## Spec\n\nP1 (won't fix: wrong, the flag exists): add a flag.\n" })).toEqual([]);
  });

  test("fails a won't-fix spec finding naming an issue that does not exist", async () => {
    expect(await rules({ review: "## Spec\n\nP1 (won't fix: belongs to #404): add a flag.\n" })).toEqual([
      "wont-fix-issue",
    ]);
  });

  test("leaves won't-fix standards findings alone", async () => {
    expect(
      await rules({ review: "## Standards\n\nS1 (won't fix: not worth it): rename.\n\n## Spec\n\nNone.\n" }),
    ).toEqual([]);
  });

  test("fails a follow-up without an issue link", async () => {
    expect(await rules({ prBody: "Closes #7\n\n## Follow-ups\n\n- P1: a flag, later\n" })).toEqual(["follow-up-link"]);
    expect(await rules({ prBody: "Closes #7\n\n## Follow-ups\n\n- P1: https://github.com/a/b/issues/9\n" })).toEqual(
      [],
    );
  });

  test("fails a body path missing from disk", async () => {
    expect(await rules({ evidence: [] })).toEqual(["evidence", "evidence"]);
  });

  test("fails a body path missing from attach, and an attach entry missing from disk", async () => {
    expect(await rules({ pr: { title: "t", attach: [] } })).toEqual(["evidence"]);
    expect(await rules({ pr: { title: "t", attach: ["out/verify/menu.png", "out/verify/gone.png"] } })).toEqual([
      "evidence",
    ]);
  });

  test("fails a commit naming another issue", async () => {
    expect(await rules({ commits: ["Menu: add it (#7)", "Lobby: fix the timer (#8)"] })).toEqual(["foreign-commit"]);
  });

  test("fails a missing or malformed pr.json", async () => {
    expect(await rules({ pr: null })).toEqual(["pr-json"]);
  });

  test("a failed gate sends the rerun back to fix", () => {
    const progress = { done: ["feedback", "setup", "implement", "review", "fix", "check", "pr"], green: true };
    expect(rewind(progress)).toEqual({ done: ["feedback", "setup", "implement", "review"], gated: true });
  });
});
