// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../store/useAppStore.js";
import { PromptPanel } from "./PromptPanel.js";
import { RunControls } from "./RunControls.js";

vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return {
    ...actual,
    fetchRecipes: vi.fn(async () => ({
      recipes: [
        {
          id: "dns-lookups",
          title: "DNS lookups",
          description: "Trace getaddrinfo calls",
          tags: ["dns"],
          view: "events",
        },
      ],
    })),
    fixtureMode: () => false,
  };
});

function renderPanels(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <PromptPanel />
      <RunControls />
    </QueryClientProvider>,
  );
}

describe("AGENT_NOT_READY UI blocking", () => {
  beforeEach(() => {
    useAppStore.setState({
      prompt: "Trace DNS lookups",
      durationS: 10,
      sessionId: "",
      generation: {
        generation_id: "gen_dns",
        script: 'uprobe:libc:getaddrinfo { printf("%s\\n", comm); }',
        chart_type: "events",
        explanation: "Traces DNS calls.",
        duration_s: 10,
        warnings: [],
        validation: { status: "ok", attempts: 1, errors: [] },
        based_on_recipe: "dns-lookups",
      },
      script: 'uprobe:libc:getaddrinfo { printf("%s\\n", comm); }',
      validationOk: true,
      validationErrors: [],
      validationProbes: ["uprobe:libc:getaddrinfo"],
      validationCode: null,
      agentReady: false,
      agentCatalogState: "loading",
      agentStatusHint: "Agent probe catalog is warming up",
      runPhase: "awaiting-confirm",
      runId: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("disables recipe picker, generation, and Review & run when agent is not ready", async () => {
    renderPanels();
    const select = await screen.findByLabelText(/insert recipe prompt/i);
    expect(select).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /generate probe/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /review & run/i }),
    ).toBeDisabled();
    expect(
      screen.getAllByText(/AGENT_NOT_READY/i).length,
    ).toBeGreaterThanOrEqual(2);
  });
});
