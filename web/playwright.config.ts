import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // demo.spec.ts records the R-24 GIF (own config + fixture build); it never
  // runs in the default suite or CI. offline.spec.ts runs against a
  // VITE_FIXTURE_MODE=1 `vite preview` of dist via
  // playwright.offline.config.ts.
  testIgnore: ["demo.spec.ts", "offline.spec.ts"],
  use: { baseURL: "http://127.0.0.1:5173" },
  webServer: {
    command: "pnpm run dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
