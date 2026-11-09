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
});
