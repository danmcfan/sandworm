import { describe as group, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expand } from "../src/batch.ts";
import { argsFor, promptPath, resolve } from "../src/config.ts";
import { journal } from "../src/journal.ts";

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
