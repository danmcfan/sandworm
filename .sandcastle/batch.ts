import { runBatch } from "../src/index.ts";
import config from "./config.ts";

// Run with `bun run sandcastle:batch [issues ...] [--workers N] [--fresh]`; issues are numbers or ranges (`10-20`).
await runBatch(config);
