import { expect, test, type Page } from "@playwright/test";

// I-17 hosted-demo gate: the VITE_FIXTURE_MODE=1 static build must run the
// full flow with zero backend traffic. Every non-loopback request is
// blocked, and any /api or /ws attempt fails the test.

interface Scenario {
  prompt: string;
  chart: { role: "img" | "log" | "table"; name: string | RegExp };
}

const SCENARIOS: Scenario[] = [
  {
    prompt: "Which processes are doing the slowest disk I/O?",
    chart: { role: "img", name: "Bar chart of latest map snapshot" },
  },
  {
    prompt: "Show new processes as they start",
    chart: { role: "log", name: "Live events" },
  },
  {
    prompt: "Show TCP retransmits over time",
    chart: { role: "img", name: "Time series of top keys" },
  },
  {
    prompt: "Count system calls by process",
    chart: { role: "img", name: "Bar chart of latest map snapshot" },
  },
  {
    prompt: "Which processes are doing DNS lookups?",
    chart: { role: "table", name: "Latest map snapshot" },
  },
];

async function runScenario(page: Page, scenario: Scenario): Promise<void> {
  await page.getByLabel(/what do you want to observe/i).fill(scenario.prompt);
  await page.getByRole("button", { name: /generate probe/i }).click();

  await expect(
    page.getByRole("button", { name: /review & run/i }),
  ).toBeVisible();
  await page.getByRole("button", { name: /review & run/i }).click();

  const runButton = page.getByRole("button", { name: /run this probe/i });
  await expect(runButton).toBeEnabled({ timeout: 10_000 });
  await expect(page.getByRole("dialog")).toContainText(
    "Demo mode: recorded data, nothing is executed",
  );
  await runButton.click();

  await expect(page.getByRole("button", { name: /^stop$/i })).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    page.getByRole(scenario.chart.role, { name: scenario.chart.name }),
  ).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: /^stop$/i }).click();
  await expect(page.getByText("Run summary")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Run completed")).toBeVisible({
    timeout: 10_000,
  });
}

function isLoopback(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost";
}

test("offline demo: five recorded scenarios, no network", async ({ page }) => {
  const blocked: string[] = [];
  const backendCalls: string[] = [];
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !isLoopback(url)
    ) {
      blocked.push(url.href);
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  page.on("request", (req) => {
    if (req.url().includes("/api/") || req.url().includes("/ws")) {
      backendCalls.push(req.url());
    }
  });

  await page.goto("/");
  await expect(
    page.getByText("Demo mode: recorded data, nothing is executed", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("agent online")).toBeVisible();

  for (const scenario of SCENARIOS) await runScenario(page, scenario);

  expect(blocked).toEqual([]);
  expect(backendCalls).toEqual([]);
});
