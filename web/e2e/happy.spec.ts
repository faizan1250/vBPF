import { expect, test } from "@playwright/test";

const GENERATION = {
  generation_id: "gen_e2e",
  script: "tracepoint:raw_syscalls:sys_enter { @syscalls[comm] = count(); }",
  chart_type: "bar",
  explanation: "Counts system calls by process name.",
  duration_s: 10,
  warnings: ["High-frequency probe; output is aggregated in-kernel."],
  validation: { status: "ok", attempts: 1, errors: [] },
  based_on_recipe: "syscall-counts-by-process",
};

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
    },
  },
};

test("happy path: prompt, review, confirm, chart, stop", async ({ page }) => {
  let stopRequested = false;

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
      body: JSON.stringify({
        recipes: [
          {
            id: "syscall-counts-by-process",
            title: "Syscall counts by process",
            description: "Counts system calls by process name",
            tags: ["syscalls"],
            view: "bar",
          },
        ],
      }),
    }),
  );
  await page.route("**/api/generate", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(GENERATION),
    }),
  );
  await page.route("**/api/validate", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        errors: [],
        probes: ["tracepoint:raw_syscalls:sys_enter"],
      }),
    }),
  );
  await page.route("**/api/runs", (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ run_id: "run_e2e", state: "running" }),
      });
    }
    return route.continue();
  });
  await page.route("**/api/runs/*/stop", (route) => {
    stopRequested = true;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ run_id: "run_e2e", state: "stopped" }),
    });
  });

  await page.routeWebSocket("**/ws/**", (ws) => {
    ws.onClose(() => {
      closed = true;
    });
    ws.send(
      JSON.stringify({
        run_id: "run_e2e",
        seq: 0,
        ts: Date.now(),
        kind: "status",
        data: { state: "running" },
      }),
    );
    let seq = 1;
    let closed = false;
    const timer = setInterval(() => {
      if (closed) {
        clearInterval(timer);
        return;
      }
      if (stopRequested) {
        clearInterval(timer);
        ws.send(
          JSON.stringify({
            run_id: "run_e2e",
            seq,
            ts: Date.now(),
            kind: "summary",
            data: {
              events: 12,
              bytes: 480,
              dropped: 0,
              duration_s: 3,
              exit_reason: "stopped",
            },
          }),
        );
        ws.send(
          JSON.stringify({
            run_id: "run_e2e",
            seq: seq + 1,
            ts: Date.now(),
            kind: "status",
            data: { state: "completed" },
          }),
        );
        ws.close();
        return;
      }
      ws.send(
        JSON.stringify({
          run_id: "run_e2e",
          seq,
          ts: Date.now(),
          kind: "map",
          data: { "@syscalls": { bash: 4 + seq, init: 9 + seq } },
        }),
      );
      seq += 1;
    }, 150);
  });

  await page.goto("/");
  await expect(page.getByText("agent online")).toBeVisible();

  await page
    .getByLabel(/what do you want to observe/i)
    .fill("Count system calls by process");
  await page.getByRole("button", { name: /generate probe/i }).click();

  await expect(
    page.getByRole("button", { name: /review & run/i }),
  ).toBeVisible();
  await page.getByRole("button", { name: /review & run/i }).click();

  const runButton = page.getByRole("button", { name: /run this probe/i });
  await expect(runButton).toBeEnabled({ timeout: 10_000 });
  await expect(
    page.getByRole("dialog").getByText(GENERATION.script),
  ).toBeVisible();
  await runButton.click();

  await expect(page.getByRole("button", { name: /^stop$/i })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("img", { name: /bar chart/i })).toBeVisible({
    timeout: 10_000,
  });

  await page.getByRole("button", { name: /^stop$/i }).click();
  await expect(page.getByText("Run summary")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Run completed")).toBeVisible({
    timeout: 10_000,
  });
});
