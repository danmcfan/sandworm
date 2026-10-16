import { defineConfig } from "../src/index.ts";

// sandworm runs its own pipeline on its own issues, straight from src/, so a change is tried
// before it is released. Branches are cut from origin/main, never from the checkout.
export default defineConfig({
  repo: "sandworm",
  base: "origin/main",
  prompts: {
    verify:
      "Cover each behaviour change with a test in `test/sandworm.test.ts`; the pipeline itself needs Docker and GitHub, so test the logic it calls.",
    reverify: "If a fix changes behaviour, update or add the test for it.",
    evidence: "out/verify",
  },
  batch: { workers: 2 },
});
