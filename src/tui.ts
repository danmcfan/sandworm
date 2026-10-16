import type { AgentStreamEvent, IterationUsage } from "@ai-hero/sandcastle";

// A full-screen progress view for the pipeline: the steps with their state, time and tokens, a
// progress bar, and the latest agent activity under it. It redraws the whole screen on a timer,
// so stray output from Sandcastle or Docker is painted over rather than tearing the layout.

type State = "waiting" | "running" | "done" | "skipped" | "stopped" | "failed";

interface Step {
  readonly name: string;
  state: State;
  note: string;
  started: number;
  ended: number;
  tokens: { input: number; output: number };
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ICON: Record<Exclude<State, "running">, string> = {
  waiting: "·",
  done: "✓",
  skipped: "↷",
  stopped: "■",
  failed: "✗",
};
const COLOUR: Record<State, string> = {
  waiting: "2",
  running: "36",
  done: "32",
  skipped: "2",
  stopped: "33",
  failed: "31",
};
const ACTIVITY_KEPT = 200;

export interface Tui {
  /** Mark a step running, with an optional note shown beside it (e.g. "round 2"). */
  start: (step: string, note?: string) => void;
  done: (step: string, note?: string) => void;
  /** Mark a step finished by an earlier run of the same issue. */
  skip: (step: string, note?: string) => void;
  /** Mark a step stopped by Ctrl-C. */
  stop: (step: string, note?: string) => void;
  fail: (step: string, note?: string) => void;
  /** Add an iteration's token usage to a step. */
  tokens: (step: string, usage: IterationUsage | undefined) => void;
  /** One line of activity under the progress bar. */
  activity: (line: string) => void;
  /** Feed for Sandcastle's `onAgentStreamEvent`. */
  event: (event: AgentStreamEvent) => void;
  /** Leave the full-screen view and print a final summary to the normal screen. */
  close: (summary: string[]) => void;
}

export function createTui(title: string, names: readonly string[]): Tui {
  const begun = Date.now();
  const steps: Step[] = names.map((name) => ({
    name,
    state: "waiting",
    note: "",
    started: 0,
    ended: 0,
    tokens: { input: 0, output: 0 },
  }));
  const lines: string[] = [];
  let frame = 0;

  const find = (name: string): Step => {
    const step = steps.find((s) => s.name === name);
    if (!step) throw new Error(`Unknown pipeline step: ${name}`);
    return step;
  };

  const render = (): void => {
    const width = process.stdout.columns || 100;
    const height = process.stdout.rows || 30;
    const finished = steps.filter((s) => s.state === "done" || s.state === "skipped").length;
    const current = steps.find((s) => s.state === "running");
    const barWidth = Math.max(10, Math.min(40, width - 30));
    const filled = Math.round((finished / steps.length) * barWidth);

    const out = [
      fit(`\u001B[1m${title}\u001B[0m`, `\u001B[2m${clock(Date.now() - begun)}\u001B[0m`, width),
      `\u001B[36m${"█".repeat(filled)}\u001B[2m${"░".repeat(barWidth - filled)}\u001B[0m ${finished}/${steps.length}  ${current?.name ?? ""}`,
      "",
      ...steps.map((s) => {
        const icon = s.state === "running" ? (SPINNER[frame % SPINNER.length] ?? "") : ICON[s.state];
        const time = s.started === 0 ? "" : clock((s.ended || Date.now()) - s.started);
        const tokens =
          s.tokens.input + s.tokens.output === 0 ? "" : `in ${count(s.tokens.input)}  out ${count(s.tokens.output)}`;
        const row = ` \u001B[${COLOUR[s.state]}m${icon}\u001B[0m ${s.name.padEnd(10)} ${time.padStart(6)}  \u001B[2m${tokens.padEnd(22)}\u001B[0m ${s.note}`;
        return truncate(row, width);
      }),
      "",
      `\u001B[2m${"─".repeat(Math.min(width, 60))}\u001B[0m`,
    ];
    const room = Math.max(0, height - out.length - 1);
    out.push(...lines.slice(-room).map((line) => truncate(line, width)));
    process.stdout.write(`\u001B[H\u001B[2J${out.join("\n")}`);
  };

  const exit = (): void => {
    clearInterval(timer);
    process.stdout.write("\u001B[?25h\u001B[?1049l");
  };
  process.stdout.write("\u001B[?1049h\u001B[?25l");
  const timer = setInterval(() => {
    frame++;
    render();
  }, 100);

  const activity = (line: string): void => {
    const time = new Date().toTimeString().slice(0, 8);
    lines.push(`\u001B[2m${time}\u001B[0m ${line}`);
    if (lines.length > ACTIVITY_KEPT) lines.shift();
  };

  return {
    start(name, note = "") {
      const step = find(name);
      if (step.state !== "running") step.started = Date.now();
      Object.assign(step, { state: "running", note, ended: 0 });
      activity(`\u001B[1m▶ ${name}\u001B[0m ${note}`);
    },
    done(name, note = "") {
      Object.assign(find(name), { state: "done", note, ended: Date.now() });
    },
    skip(name, note = "") {
      Object.assign(find(name), { state: "skipped", note });
    },
    stop(name, note = "") {
      Object.assign(find(name), { state: "stopped", note, ended: Date.now() });
    },
    fail(name, note = "") {
      Object.assign(find(name), { state: "failed", note, ended: Date.now() });
    },
    tokens(name, usage) {
      if (!usage) return;
      const { tokens } = find(name);
      tokens.input += usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
      tokens.output += usage.outputTokens;
    },
    activity,
    event(event) {
      if (event.type === "toolCall") activity(`\u001B[33m${event.name}\u001B[0m ${oneLine(event.formattedArgs)}`);
      if (event.type === "text" && event.message.trim() !== "") activity(oneLine(event.message));
    },
    close(summary) {
      exit();
      process.stdout.write(`${summary.join("\n")}\n`);
    },
  };
}

const oneLine = (text: string): string => text.replaceAll(/\s+/gu, " ").trim();

const clock = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const count = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

const ESC = "\u001B";

// Split text into colour codes (`ESC[…m`, which take no space on screen) and the text between them.
function pieces(text: string): { code: string; text: string }[] {
  const [first = "", ...rest] = text.split(ESC);
  return [
    { code: "", text: first },
    ...rest.map((part) => {
      const end = part.indexOf("m") + 1;
      return { code: ESC + part.slice(0, end), text: part.slice(end) };
    }),
  ];
}

const visible = (text: string): number => pieces(text).reduce((width, piece) => width + piece.text.length, 0);

function truncate(text: string, width: number): string {
  if (visible(text) <= width) return text;
  let shown = 0;
  let out = "";
  for (const piece of pieces(text)) {
    out += piece.code + piece.text.slice(0, Math.max(0, width - 1 - shown));
    shown += piece.text.length;
  }
  return `${out}…${ESC}[0m`;
}

const fit = (left: string, right: string, width: number): string =>
  `${left}${" ".repeat(Math.max(1, width - visible(left) - visible(right)))}${right}`;

export interface BatchTui {
  /** A Reporter for one issue's pipeline run, drawn as that issue's row. */
  reporter: (issue: string) => Omit<Tui, "close">;
  /** Set an issue's row outside the pipeline (merge, the outcome). */
  set: (issue: string, state: State, step: string, note?: string) => void;
  activity: (line: string) => void;
  close: (summary: string[]) => void;
}

// The batch view: one row per issue with its current step, time and tokens, then the latest
// activity from every issue, prefixed with its number.
export function createBatchTui(title: string, issues: readonly { issue: string; tag: string }[]): BatchTui {
  const begun = Date.now();
  interface Row {
    issue: string;
    tag: string;
    state: State;
    step: string;
    note: string;
    started: number;
    ended: number;
    tokens: { input: number; output: number };
  }
  const rows = issues.map(({ issue, tag }): Row => ({
    issue,
    tag,
    state: "waiting",
    step: "",
    note: "",
    started: 0,
    ended: 0,
    tokens: { input: 0, output: 0 },
  }));
  const lines: string[] = [];
  let frame = 0;

  const find = (issue: string): Row => {
    const row = rows.find((r) => r.issue === issue);
    if (!row) throw new Error(`Unknown batch issue: ${issue}`);
    return row;
  };
  const activity = (line: string): void => {
    const time = new Date().toTimeString().slice(0, 8);
    lines.push(`\u001B[2m${time}\u001B[0m ${line}`);
    if (lines.length > ACTIVITY_KEPT) lines.shift();
  };
  const set = (issue: string, state: State, step: string, note = ""): void => {
    const row = find(issue);
    if (row.started === 0 && state === "running") row.started = Date.now();
    if (state !== "running" && state !== "waiting") row.ended = Date.now();
    Object.assign(row, { state, step, note });
  };

  const render = (): void => {
    const width = process.stdout.columns || 100;
    const height = process.stdout.rows || 30;
    const finished = rows.filter((r) => r.state !== "waiting" && r.state !== "running").length;
    const out = [
      fit(
        `\u001B[1m${title}\u001B[0m  ${finished}/${rows.length} finished`,
        `\u001B[2m${clock(Date.now() - begun)}\u001B[0m`,
        width,
      ),
      "",
      ...rows.map((r) => {
        const icon = r.state === "running" ? (SPINNER[frame % SPINNER.length] ?? "") : ICON[r.state];
        const time = r.started === 0 ? "" : clock((r.ended || Date.now()) - r.started);
        const tokens =
          r.tokens.input + r.tokens.output === 0 ? "" : `in ${count(r.tokens.input)}  out ${count(r.tokens.output)}`;
        const row = ` \u001B[${COLOUR[r.state]}m${icon}\u001B[0m #${r.issue.padEnd(5)} \u001B[2m${r.tag.padEnd(5)}\u001B[0m ${r.step.padEnd(10)} ${time.padStart(6)}  \u001B[2m${tokens.padEnd(22)}\u001B[0m ${r.note}`;
        return truncate(row, width);
      }),
      "",
      `\u001B[2m${"─".repeat(Math.min(width, 60))}\u001B[0m`,
    ];
    const room = Math.max(0, height - out.length - 1);
    out.push(...lines.slice(-room).map((line) => truncate(line, width)));
    process.stdout.write(`\u001B[H\u001B[2J${out.join("\n")}`);
  };

  process.stdout.write("\u001B[?1049h\u001B[?25l");
  const timer = setInterval(() => {
    frame++;
    render();
  }, 100);

  return {
    reporter(issue) {
      const row = find(issue);
      const say = (line: string): void => {
        activity(`\u001B[1m#${issue}\u001B[0m ${line}`);
      };
      return {
        start(step, note = "") {
          set(issue, "running", step, note);
          say(`\u001B[1m▶ ${step}\u001B[0m ${note}`);
        },
        done(step, note = "") {
          set(issue, "running", step, note);
        },
        skip(step, note = "") {
          set(issue, "running", step, note);
        },
        stop(step, note = "") {
          set(issue, "stopped", step, note);
        },
        fail(step, note = "") {
          set(issue, "failed", step, note);
        },
        tokens(_step, usage) {
          if (!usage) return;
          row.tokens.input += usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
          row.tokens.output += usage.outputTokens;
        },
        activity: say,
        event(event) {
          if (event.type === "toolCall") say(`\u001B[33m${event.name}\u001B[0m ${oneLine(event.formattedArgs)}`);
          if (event.type === "text" && event.message.trim() !== "") say(oneLine(event.message));
        },
      };
    },
    set,
    activity,
    close(summary) {
      clearInterval(timer);
      process.stdout.write("\u001B[?25h\u001B[?1049l");
      process.stdout.write(`${summary.join("\n")}\n`);
    },
  };
}
