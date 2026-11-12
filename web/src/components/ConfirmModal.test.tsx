// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmModal } from "./ConfirmModal.js";
import { createRun } from "../lib/api.js";
import { useAppStore } from "../store/useAppStore.js";

vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return { ...actual, fixtureMode: () => false, createRun: vi.fn() };
});

const createRunMock = vi.mocked(createRun);

function renderModal(): void {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <ConfirmModal />
    </QueryClientProvider>,
  );
}

describe("ConfirmModal", () => {
  afterEach(() => {
    cleanup();
    createRunMock.mockReset();
  });
  beforeEach(() => {
    useAppStore.setState({
      confirmOpen: true,
      script: "BEGIN { }",
      durationS: 10,
      generation: null,
      runId: null,
      runOrigin: null,
      validationOk: false,
      validationErrors: ["probe not found: tracepoint:foo:bar"],
      validationWarnings: [],
      validationCode: null,
      validationFixHint: null,
      agentReady: null,
      agentStatusHint: null,
    });
  });

  it("disables run while validation is not ok", () => {
    renderModal();
    const run = screen.getByRole("button", { name: /run this probe/i });
    expect(run).toBeDisabled();
    expect(screen.getByText(/validation must be ok/i)).toBeDefined();
  });

  it("enables run once validation passes", () => {
    useAppStore.getState().setValidation(true, [], ["BEGIN"]);
    renderModal();
    const run = screen.getByRole("button", { name: /run this probe/i });
    expect(run).not.toBeDisabled();
  });

  it("shows the exact script under review", () => {
    renderModal();
    expect(screen.getByText("BEGIN { }")).toBeDefined();
  });

  it("blocks run when agent is AGENT_NOT_READY", () => {
    useAppStore.setState({
      validationOk: true,
      validationProbes: ["BEGIN"],
      agentReady: false,
      agentStatusHint: "Mount tracefs and retry",
    });
    renderModal();
    const run = screen.getByRole("button", { name: /run this probe/i });
    expect(run).toBeDisabled();
    expect(screen.getByText(/AGENT_NOT_READY/)).toBeDefined();
  });

  it("displays live validation warnings in the confirm modal", () => {
    useAppStore.setState({
      validationOk: true,
      validationProbes: ["uprobe:libc:malloc"],
      validationWarnings: ['Hot libc symbol "malloc" fires at high frequency.'],
    });
    renderModal();
    expect(screen.getByText(/Hot libc symbol "malloc"/)).toBeDefined();
  });

  it("forwards generation_id when starting a run", async () => {
    createRunMock.mockResolvedValue({
      run_id: "run_1",
      state: "running",
      origin: "generated",
    });
    useAppStore.setState({
      script: "BEGIN { }",
      durationS: 10,
      generation: {
        generation_id: "gen_123",
        script: "BEGIN { }",
        chart_type: "events",
        explanation: "Counts.",
        duration_s: 10,
        warnings: [],
        validation: { status: "ok", attempts: 1, errors: [] },
        based_on_recipe: null,
      },
      validationOk: true,
      validationProbes: ["BEGIN"],
      validationWarnings: [],
      agentReady: null,
    });
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: /run this probe/i }));
    await waitFor(() =>
      expect(createRunMock).toHaveBeenCalledWith("BEGIN { }", 10, "gen_123"),
    );
  });

  it("forwards generation_id when the script was edited", async () => {
    createRunMock.mockResolvedValue({
      run_id: "run_1",
      state: "running",
      origin: "edited",
    });
    useAppStore.setState({
      script: "BEGIN { @b = 2; }",
      durationS: 10,
      generation: {
        generation_id: "gen_123",
        script: "BEGIN { @a = 1; }",
        chart_type: "events",
        explanation: "Counts.",
        duration_s: 10,
        warnings: [],
        validation: { status: "ok", attempts: 1, errors: [] },
        based_on_recipe: null,
      },
      validationOk: true,
      validationProbes: ["BEGIN"],
      validationWarnings: [],
      agentReady: null,
    });
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: /run this probe/i }));
    await waitFor(() =>
      expect(createRunMock).toHaveBeenCalledWith(
        "BEGIN { @b = 2; }",
        10,
        "gen_123",
      ),
    );
  });

  it("omits generation_id when there is no generation", async () => {
    createRunMock.mockResolvedValue({
      run_id: "run_1",
      state: "running",
      origin: "recipe",
    });
    useAppStore.setState({
      script: "BEGIN { }",
      durationS: 10,
      generation: null,
      validationOk: true,
      validationProbes: ["BEGIN"],
      validationWarnings: [],
      agentReady: null,
    });
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: /run this probe/i }));
    await waitFor(() =>
      expect(createRunMock).toHaveBeenCalledWith("BEGIN { }", 10, undefined),
    );
  });

  it("stores the server-derived origin on success", async () => {
    createRunMock.mockResolvedValue({
      run_id: "run_1",
      state: "running",
      origin: "recipe",
    });
    useAppStore.setState({
      script: "BEGIN { }",
      durationS: 10,
      generation: null,
      validationOk: true,
      validationProbes: ["BEGIN"],
      validationWarnings: [],
      agentReady: null,
    });
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: /run this probe/i }));
    await waitFor(() =>
      expect(createRunMock).toHaveBeenCalledWith("BEGIN { }", 10, undefined),
    );
    expect(useAppStore.getState().runOrigin).toBe("recipe");
  });
});
