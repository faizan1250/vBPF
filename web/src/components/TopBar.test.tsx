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
  return { ...actual, fetchHealth: vi.fn(), fixtureMode: () => false };
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

describe("TopBar", () => {
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

  it("shows agent online and updates store when catalog is ready", async () => {
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
    expect(await screen.findByText(/agent online/i)).toBeInTheDocument();
    expect(useAppStore.getState().agentReady).toBe(true);
    expect(useAppStore.getState().agentCatalogState).toBe("ready");
  });

  it("shows AGENT_NOT_READY and marks store not ready when catalog is loading or failed", async () => {
    const payload: HealthResponse = {
      ok: true,
      agent: {
        reachable: true,
        warnings: ["AGENT_NOT_READY"],
        health: {
          kernel: "6.8.0",
          bpftrace_version: "bpftrace v0.20.4",
          btf: true,
          root: true,
          tracefs: false,
          uptime_s: 3,
          ready: false,
          catalog: {
            state: "failed",
            probes: 0,
            last_error: "bpftrace -l failed",
            warnings: [],
          },
        },
      },
    };
    fetchHealthMock.mockResolvedValue(payload);

    renderTopBar();
    expect(
      await screen.findByText(/AGENT_NOT_READY \(failed\)/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Mount debugfs\/tracefs/i)).toBeInTheDocument();
    expect(useAppStore.getState().agentReady).toBe(false);
    expect(useAppStore.getState().agentCatalogState).toBe("failed");
  });

  it("surfaces catalog tracefs warning when ready without tracepoints", async () => {
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
          tracefs: false,
          uptime_s: 15,
          ready: true,
          catalog: {
            state: "ready",
            probes: 5,
            warnings: [
              "catalog contains no tracepoint probes; tracefs may not be mounted",
            ],
          },
        },
      },
    };
    fetchHealthMock.mockResolvedValue(payload);

    renderTopBar();
    const matches = await screen.findAllByText(
      /catalog contains no tracepoint probes/i,
    );
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });
});
