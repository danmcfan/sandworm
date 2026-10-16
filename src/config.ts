import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GateRule } from "./gate.ts";

/** What a repo tells the pipeline about itself, in `.sandcastle/config.ts`. */
export interface Config {
  /** The repo's name, as the prompts say it: "You work in the <repo> repo". */
  repo: string;
  /** The branch an issue's work goes on. Defaults to `agent/<issue>`. */
  branch?: (issue: string) => string;
  /**
   * Where a new branch is cut from: "HEAD", the branch you have checked out, or "origin/main",
   * fetched before each issue so a branch builds on the latest main. Defaults to "HEAD".
   */
  base?: "HEAD" | "origin/main";
  /**
   * Gitignored directories in the worktree that hold step output (out/pipeline) or the PR's
   * screenshots and videos, kept in .sandcastle/logs/<issue>/ between runs. Defaults to ["out"].
   */
  keep?: string[];
  /** Repo-specific text the shared prompts paste in. */
  prompts: {
    /** How the implement and address agents verify a change, as one numbered step's text. */
    verify: string;
    /** How the fix agent re-verifies, as one sentence. */
    reverify: string;
    /** The directory the PR agent picks screenshots and videos from, e.g. "out/verify". */
    evidence: string;
  };
  /**
   * The repo's own gate rules, run after the built-in ones on the same artefacts. Their failures
   * fail the run like any other. Defaults to [].
   */
  gates?: GateRule[];
  batch?: {
    /** Issues run at once. Defaults to 1. */
    workers?: number;
    /**
     * Merge each `bug` issue's green PR once CI passes, one bug at a time, each cut from the
     * latest origin/main. Defaults to false: every issue stops at an open PR.
     */
    mergeBugs?: boolean;
    /** Issues carrying any of these labels wait for the owner and are left out. Defaults to ["needs-owner"]. */
    skipLabels?: string[];
  };
}

/** A Config with its defaults filled in. */
export interface Resolved {
  repo: string;
  branch: (issue: string) => string;
  base: "HEAD" | "origin/main";
  keep: string[];
  /** What the prompts diff and log against: main for a HEAD base, origin/main otherwise. */
  compare: string;
  workers: number;
  mergeBugs: boolean;
  skipLabels: string[];
  gates: GateRule[];
  /** The prompt args every prompt may use. */
  args: Record<string, string>;
}

export const defineConfig = (config: Config): Config => config;

export function resolve(config: Config): Resolved {
  const base = config.base ?? "HEAD";
  const compare = base === "HEAD" ? "main" : base;
  return {
    repo: config.repo,
    branch: config.branch ?? ((issue) => `agent/${issue}`),
    base,
    keep: config.keep ?? ["out"],
    compare,
    workers: config.batch?.workers ?? 1,
    mergeBugs: config.batch?.mergeBugs ?? false,
    skipLabels: config.batch?.skipLabels ?? ["needs-owner"],
    gates: config.gates ?? [],
    args: {
      REPO: config.repo,
      BASE: compare,
      VERIFY: config.prompts.verify,
      REVERIFY: config.prompts.reverify,
      EVIDENCE: config.prompts.evidence,
    },
  };
}

const SHARED_PROMPTS = fileURLToPath(new URL("../prompts", import.meta.url));

/** The repo's own `.sandcastle/<name>`, if it has one, otherwise sandworm's. */
export function promptPath(name: string): string {
  const own = `.sandcastle/${name}`;
  return existsSync(own) ? own : `${SHARED_PROMPTS}/${name}`;
}

/** The args from `available` that the prompt refers to, so Sandcastle warns of none left over. */
export async function argsFor(path: string, available: Record<string, string>): Promise<Record<string, string>> {
  const text = await Bun.file(path).text();
  const used = new Set([...text.matchAll(/\{\{\s*([A-Za-z_]\w*)\s*\}\}/gu)].map((match) => match[1]));
  return Object.fromEntries(Object.entries(available).filter(([key]) => used.has(key)));
}
