// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmModal } from "./ConfirmModal.js";
import { createRun } from "../lib/api.js";
import { useAppStore } from "../store/useAppStore.js";

vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return { ...actual, fixtureMode: () => true, createRun: vi.fn() };
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

describe("ConfirmModal fixture mode", () => {
  afterEach(() => {
    cleanup();
    createRunMock.mockReset();
  });

  beforeEach(() => {
    useAppStore.setState({
      confirmOpen: true,
      script: "uprobe:libc:getaddrinfo { @dns[comm] = count(); }",
      durationS: 10,
      generation: {
        generation_id: "gen_fixture_dns-lookups_123",
        script: "uprobe:libc:getaddrinfo { @dns[comm] = count(); }",
        chart_type: "table",
        explanation: "Fixture replay.",
        duration_s: 10,
        warnings: [],
        validation: { status: "ok", attempts: 1, errors: [] },
        based_on_recipe: null,
      },
      runId: null,
      runOrigin: null,
      validationOk: true,
      validationErrors: [],
      validationWarnings: [],
      validationProbes: ["uprobe:libc:getaddrinfo"],
      validationCode: null,
      validationFixHint: null,
      agentReady: null,
      agentStatusHint: null,
    });
  });

  it("warns that nothing is executed and replays locally", async () => {
    renderModal();
    expect(
      screen.getByText(/nothing is executed/, { exact: false }),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /run this probe/i }));
    await waitFor(() =>
      expect(
        useAppStore.getState().runId?.startsWith("run_fixture_dns-lookups_"),
      ).toBe(true),
    );
    expect(createRunMock).not.toHaveBeenCalled();
  });
});
