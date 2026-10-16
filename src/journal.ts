import { $ } from "bun";
import { appendFileSync, mkdirSync } from "node:fs";

// .sandcastle/logs/<issue>/error.log: every way a run can end early, with the error, its stack and
// any failed command's stderr. The agent logs only hold the agent's stream, so without this a
// container or agent that dies leaves a log that just stops, and the error goes only to a
// terminal that may be gone.

/** An error's message, with a failed shell command's stderr (a push hook's or gh's reason) appended. */
export function describe(error: unknown): string {
  if (error instanceof $.ShellError) return `${error.message}\n${error.stderr.toString().trim()}`;
  return error instanceof Error ? error.message : String(error);
}

/** Appends an entry to `<logs>/error.log`, and to `alsoTo` (the agent log that was running) if given. */
export function journal(logs: string, step: string, what: string, error?: unknown, alsoTo?: string): void {
  const detail =
    error === undefined
      ? ""
      : `\n${describe(error)}${error instanceof Error && error.stack !== undefined ? `\n${error.stack}` : ""}`;
  const entry = `\n--- ${new Date().toISOString()} · ${step} · ${what} ---${detail}\n`;
  for (const file of alsoTo === undefined ? [`${logs}/error.log`] : [`${logs}/error.log`, alsoTo]) {
    try {
      mkdirSync(logs, { recursive: true });
      appendFileSync(file, entry);
    } catch {
      // Recording must never hide the error being recorded.
    }
  }
}

/** Where each running issue is, for a record of how the process ended. */
export type Running = () => { logs: string; step: string }[];

/**
 * Makes every way the process can end leave a line in each running issue's error.log: Ctrl-C,
 * SIGTERM, a closed terminal (SIGHUP), an uncaught error, or an exit before the run finished.
 * `interrupt` handles the signals; it should abort the runs so they record where they stopped.
 */
export function guard(running: Running, interrupt: (signal: string) => void): { finished: () => void } {
  let done = false;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      interrupt(signal);
    });
  }
  const crash = (error: unknown): void => {
    for (const { logs, step } of running()) journal(logs, step, "crashed: uncaught error", error);
    console.error(error);
    process.exit(1);
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  process.on("exit", (code) => {
    if (done) return;
    for (const { logs, step } of running())
      journal(logs, step, `process exited (code ${code}) before the run finished`);
  });
  return {
    finished: () => {
      done = true;
    },
  };
}
