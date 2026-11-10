import { defineConfig } from "@playwright/test";

// R-24 demo recording config. The server is started by
// scripts/make-demo.sh with VITE_FIXTURE_MODE=1; this config only drives the
// walkthrough (web/e2e/demo.spec.ts) with video capture on.
export default defineConfig({
  testDir: "./e2e",
  testMatch: ["demo.spec.ts"],
  timeout: 180_000,
  use: {
    baseURL: "http://127.0.0.1:5173",
    video: { mode: "on", size: { width: 1280, height: 800 } },
    viewport: { width: 1280, height: 800 },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
