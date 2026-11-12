import { defineConfig } from "@playwright/test";

// I-17 hosted-demo gate: runs against `vite preview` serving a
// VITE_FIXTURE_MODE=1 build of dist, with the Pages subpath when
// VITE_BASE_PATH is set. Build first, e.g.
// VITE_FIXTURE_MODE=1 VITE_BASE_PATH=/vBPF/ pnpm run build
function previewBase(): string {
  const raw = process.env["VITE_BASE_PATH"] ?? "/";
  const trimmed = raw.trim() === "" ? "/" : raw.trim();
  return trimmed === "/" ? "" : trimmed.replace(/\/+$/, "");
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["offline.spec.ts"],
  timeout: 180_000,
  use: { baseURL: `http://127.0.0.1:4173${previewBase()}` },
  webServer: {
    command: "pnpm exec vite preview --port 4173 --strictPort",
    url: `http://127.0.0.1:4173${previewBase()}/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
