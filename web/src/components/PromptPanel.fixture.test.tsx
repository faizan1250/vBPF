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

import { useAppStore } from "../store/useAppStore.js";
import { PromptPanel } from "./PromptPanel.js";

vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return {
    ...actual,
    fetchRecipes: vi.fn(async () => ({ recipes: [] })),
    fixtureMode: () => true,
  };
});

const { fetchRecipes } = await import("../lib/api.js");
const fetchRecipesMock = vi.mocked(fetchRecipes);

function renderPanel(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <PromptPanel />
    </QueryClientProvider>,
  );
}

describe("PromptPanel fixture mode", () => {
  beforeEach(() => {
    useAppStore.setState({
      prompt: "",
      durationS: 10,
      sessionId: "",
      generation: null,
      script: "",
      validationOk: null,
      validationErrors: [],
      validationProbes: [],
      agentReady: null,
      agentStatusHint: null,
      runPhase: "idle",
      runId: null,
    });
  });

  afterEach(() => {
    cleanup();
    fetchRecipesMock.mockReset();
  });

  it("offers five example prompts without hitting the network", async () => {
    renderPanel();
    for (const prompt of [
      "Which processes are doing the slowest disk I/O?",
      "Show new processes as they start",
      "Show TCP retransmits over time",
      "Count system calls by process",
      "Which processes are doing DNS lookups?",
    ]) {
      expect(await screen.findByText(prompt)).toBeInTheDocument();
    }
    expect(fetchRecipesMock).not.toHaveBeenCalled();
  });

  it("serves five local recipes from the picker", async () => {
    renderPanel();
    const select = await screen.findByLabelText(/insert recipe prompt/i);
    expect(select.querySelectorAll("option")).toHaveLength(6);
  });

  it("routes the DNS example to the table scenario", async () => {
    renderPanel();
    fireEvent.click(
      await screen.findByText("Which processes are doing DNS lookups?"),
    );
    fireEvent.click(screen.getByRole("button", { name: /generate probe/i }));
    await waitFor(() => {
      const generation = useAppStore.getState().generation;
      expect(generation?.chart_type).toBe("table");
      expect(
        generation?.generation_id.startsWith("gen_fixture_dns-lookups_"),
      ).toBe(true);
    });
  });
});
