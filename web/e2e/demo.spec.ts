import { expect, test, type Page } from "@playwright/test";

// R-24 demo recording: three fixture scenarios end to end, paced for a
// 60-90 s GIF. Run only via scripts/make-demo.sh against a
// VITE_FIXTURE_MODE=1 build; excluded from the default config (never CI).

const HEALTH = {
  ok: true,
  agent: {
    reachable: true,
    warnings: [],
    health: {
      kernel: "6.6.0",
      bpftrace_version: "0.20.0",
      btf: true,
      root: true,
      tracefs: true,
      uptime_s: 60,
      ready: true,
      catalog: {
        state: "ready",
        probes: 1,
        warnings: [],
      },
    },
  },
};

interface Scenario {
  prompt: string;
  chart: { role: "img" | "log"; name: string | RegExp };
  streamMs: number;
}

const SCENARIOS: Scenario[] = [
  {
    // "slow disk by process": bar view of the synthetic map replay.
    prompt: "Which processes are doing the slowest disk I/O?",
    chart: { role: "img", name: "Bar chart of latest map snapshot" },
    streamMs: 14_000,
  },
  {
    // "outbound connections": the "start" keyword selects the events view.
    prompt: "Show outbound TCP connections as they start",
    chart: { role: "log", name: "Live events" },
    streamMs: 8_000,
  },
  {
    // "TCP retransmit histogram": the "histogram" keyword selects hist view.
    prompt: "Histogram of TCP retransmit latency by process",
    chart: { role: "img", name: "Histogram of bucketed values" },
    streamMs: 14_000,
  },
];

async function stubBackend(page: Page): Promise<void> {
  await page.route("**/api/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(HEALTH),
    }),
  );
  await page.route("**/api/recipes*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ recipes: [] }),
    }),
  );
}

async function runScenario(page: Page, scenario: Scenario): Promise<void> {
  const prompt = page.getByLabel(/what do you want to observe/i);
  await prompt.fill("");
  await prompt.pressSequentially(scenario.prompt, { delay: 30 });
  await page.getByRole("button", { name: /generate probe/i }).click();

  await expect(
    page.getByRole("button", { name: /review & run/i }),
  ).toBeVisible();
  await page.getByRole("button", { name: /review & run/i }).click();

  const runButton = page.getByRole("button", { name: /run this probe/i });
  await expect(runButton).toBeEnabled({ timeout: 10_000 });
  await runButton.click();

  await expect(page.getByRole("button", { name: /^stop$/i })).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    page.getByRole(scenario.chart.role, { name: scenario.chart.name }),
  ).toBeVisible({ timeout: 10_000 });

  await page.waitForTimeout(scenario.streamMs);

  // The replay can auto-complete on event count; only stop if still running.
  const stop = page.getByRole("button", { name: /^stop$/i });
  if (await stop.isVisible()) await stop.click();
  await expect(page.getByText("Run summary")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(3_000);
}

test("demo: three fixture scenarios", async ({ page }) => {
  await stubBackend(page);
  await page.goto("/");
  await expect(page.getByText("agent online")).toBeVisible();
  await expect(page.getByText("fixture replay")).toBeVisible();
  await page.waitForTimeout(5_000);

  for (const scenario of SCENARIOS) await runScenario(page, scenario);

  await page.waitForTimeout(5_000);
});
