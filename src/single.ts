import { $ } from "bun";
import { resolve, type Config } from "./config.ts";
import { describe, guard } from "./journal.ts";
import { containers, logsFor, outcome, runIssue, STEPS, usageReport, type IssueRun } from "./pipeline.ts";
import { createTui } from "./tui.ts";

/**
 * `bun run sandcastle [issue-number] [--fresh]`: one issue through the pipeline. With no number it
 * takes the lowest-numbered open ready-for-agent issue.
 *
 * The terminal shows a progress view. Ctrl-C stops the agent and removes the container; a second
 * Ctrl-C force-removes it and quits. Running the same issue again carries on where it stopped.
 */
export async function runSingle(config: Config, args = process.argv.slice(2)): Promise<void> {
  const resolved = resolve(config);
  const fresh = args.includes("--fresh");
  const issue =
    args.find((arg) => arg !== "--fresh") ??
    (
      await $`gh issue list --label ready-for-agent --state open --json number --jq 'map(.number) | min // empty'`.text()
    ).trim();
  if (issue === "") throw new Error("No open ready-for-agent issue; pass an issue number.");
  if (!/^\d+$/u.test(issue)) throw new Error(`Not an issue number: ${issue}.`);

  const logs = logsFor(issue);
  const runs: IssueRun["runs"] = [];
  const tui = createTui(`Sandcastle · issue #${issue} · ${resolved.branch(issue)}`, STEPS);
  let current = "setup";

  // The first signal aborts the run so the container is removed and error.log says where it
  // stopped; a second Ctrl-C removes every Sandcastle container this run started and quits at once.
  const stop = new AbortController();
  const before = new Set(containers());
  let interrupts = 0;
  const { finished } = guard(
    () => [{ logs, step: current }],
    (signal) => {
      interrupts++;
      if (interrupts === 1) {
        tui.activity("\u001B[33mStopping\u001B[0m: removing the container. Ctrl-C again to force quit.");
        stop.abort(new Error(`Interrupted (${signal})`));
        return;
      }
      const ours = containers().filter((id) => !before.has(id));
      if (ours.length > 0) Bun.spawnSync(["docker", "rm", "-f", ...ours]);
      tui.close([`Force quit during ${current}. Removed ${ours.length} container(s).`]);
      process.exit(130);
    },
  );

  try {
    const progress = await runIssue({
      config: resolved,
      issue,
      fresh,
      reporter: tui,
      signal: stop.signal,
      runs,
      onStep: (step) => {
        current = step;
      },
    });
    finished();
    tui.close([`${outcome(progress)}: ${progress.url ?? ""}`, `Logs: ${logs}/`, "", ...usageReport(runs)]);
  } catch (error) {
    // runIssue has written the error and its stack to error.log.
    finished();
    if (!stop.signal.aborted) {
      tui.fail(current, "failed");
      tui.close([
        `Failed during ${current}: ${describe(error)}`,
        `Logs: ${logs}/ (the stack is in error.log)`,
        "",
        ...usageReport(runs),
      ]);
      process.exitCode = 1;
      return;
    }
    tui.stop(current, "stopped (Ctrl-C)");
    tui.close([
      `Stopped during ${current}; the container is removed.`,
      `Run \`bun run sandcastle ${issue}\` to carry on from ${current}, or add --fresh to start over.`,
      `Logs: ${logs}/`,
      "",
      ...usageReport(runs),
    ]);
    process.exitCode = 130;
  }
}
