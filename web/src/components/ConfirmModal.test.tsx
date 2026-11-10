// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfirmModal } from "./ConfirmModal.js";
import { useAppStore } from "../store/useAppStore.js";

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
  });
  beforeEach(() => {
    useAppStore.setState({
      confirmOpen: true,
      script: "BEGIN { }",
      durationS: 10,
      generation: null,
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
});
