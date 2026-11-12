// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HealthResponse } from "../lib/api.js";
import { useAppStore } from "../store/useAppStore.js";
import { TopBar } from "./TopBar.js";

vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return { ...actual, fetchHealth: vi.fn(), fixtureMode: () => true };
});

const { fetchHealth } = await import("../lib/api.js");
const fetchHealthMock = vi.mocked(fetchHealth);

function renderTopBar(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TopBar />
    </QueryClientProvider>,
  );
}

describe("TopBar fixture mode", () => {
  beforeEach(() => {
    useAppStore.setState({
      agentReady: null,
      agentCatalogState: null,
      agentStatusHint: null,
    });
  });

  afterEach(() => {
    cleanup();
    fetchHealthMock.mockReset();
  });

  it("stays offline and reports a synthetic online agent", async () => {
    const payload: HealthResponse = {
      ok: true,
      agent: {
        reachable: true,
        warnings: [],
        health: {
          kernel: "6.8.0",
          bpftrace_version: "bpftrace v0.20.4",
          btf: true,
          root: true,
          tracefs: true,
          uptime_s: 10,
          ready: true,
          catalog: { state: "ready", probes: 42, warnings: [] },
        },
      },
    };
    fetchHealthMock.mockResolvedValue(payload);

    renderTopBar();
    expect(await screen.findByText(/fixture replay/i)).toBeInTheDocument();
    expect(await screen.findByText(/agent online/i)).toBeInTheDocument();
    expect(fetchHealthMock).not.toHaveBeenCalled();
    expect(useAppStore.getState().agentReady).toBe(true);
  });
});
