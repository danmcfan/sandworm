import { runSingle } from "../src/index.ts";
import config from "./config.ts";

// Run with `bun run sandcastle [issue-number] [--fresh]`. Needs Docker and .sandcastle/.env (copy .env.example).
await runSingle(config);
