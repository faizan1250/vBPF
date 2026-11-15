// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HistoryPanel } from "./HistoryPanel.js";
import {
  fetchSession,
  fetchSessionExport,
  fetchSessions,
  fixtureMode,
} from "../lib/api.js";
import { saveHistory } from "../lib/history.js";
import { useAppStore } from "../store/useAppStore.js";

vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return {
    ...actual,
    fixtureMode: vi.fn(() => false),
    fetchSessions: vi.fn(),
    fetchSession: vi.fn(),
    fetchSessionExport: vi.fn(),
  };
});

const fixtureModeMock = vi.mocked(fixtureMode);
const fetchSessionsMock = vi.mocked(fetchSessions);
const fetchSessionMock = vi.mocked(fetchSession);
const fetchSessionExportMock = vi.mocked(fetchSessionExport);

const SERVER_SESSION = {
  id: "ses_1",
  title: "Which processes use CPU?",
  created_at: 1_700_000_000_000,
  generations: 2,
  runs: 1,
};

function seedLocal(): void {
  saveHistory({
    id: "local-1",
    title: "local entry",
    createdAt: 1,
    prompt: "local prompt",
    script: "BEGIN { }",
    chartType: "bar",
    explanation: "e",
    durationS: 10,
    warnings: [],
    runId: null,
    origin: "edited",
    exitReason: null,
    eventsSample: [],
  });
}

describe("HistoryPanel server-first", () => {
  beforeEach(() => {
    localStorage.clear();
    cleanup();
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    fixtureModeMock.mockReturnValue(false);
    fetchSessionsMock.mockReset();
    fetchSessionMock.mockReset();
    fetchSessionExportMock.mockReset();
    useAppStore.setState({
      prompt: "",
      script: "",
      durationS: 10,
      sessionId: "",
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("lists server sessions when the backend is reachable", async () => {
    fetchSessionsMock.mockResolvedValue({ sessions: [SERVER_SESSION] });
    render(<HistoryPanel />);
    expect(await screen.findByText("Which processes use CPU?")).toBeDefined();
    expect(screen.getByText("2 gen · 1 runs")).toBeDefined();
    expect(screen.queryByText(/browser-local/i)).toBeNull();
  });

  it("falls back to browser-local entries when the server is down", async () => {
    seedLocal();
    fetchSessionsMock.mockRejectedValue(new Error("down"));
    render(<HistoryPanel />);
    expect(await screen.findByText("local entry")).toBeDefined();
    expect(screen.getByText(/server history unavailable/i)).toBeDefined();
  });

  it("stays local in fixture mode without calling the server", async () => {
    seedLocal();
    fixtureModeMock.mockReturnValue(true);
    render(<HistoryPanel />);
    expect(await screen.findByText("local entry")).toBeDefined();
    expect(fetchSessionsMock).not.toHaveBeenCalled();
  });

  it("loads the latest generation into the prompt on Load", async () => {
    fetchSessionsMock.mockResolvedValue({ sessions: [SERVER_SESSION] });
    fetchSessionMock.mockResolvedValue({
      id: "ses_1",
      title: "Which processes use CPU?",
      created_at: 1_700_000_000_000,
      generations: [
        {
          generation_id: "gen_1",
          prompt: "Which processes use CPU?",
          script: "BEGIN { @x = count(); }",
          chart_type: "bar",
          explanation: "e",
          duration_s: 10,
          validation_status: "ok",
          attempts: 1,
          model: "mock",
          based_on_recipe: null,
          created_at: 1_700_000_000_001,
        },
      ],
      runs: [],
    });
    render(<HistoryPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /^load /i }));
    await waitFor(() => {
      expect(useAppStore.getState().prompt).toBe("Which processes use CPU?");
      expect(useAppStore.getState().script).toBe("BEGIN { @x = count(); }");
    });
    expect(fetchSessionMock).toHaveBeenCalledWith("ses_1");
  });

  it("fetches the server export on Export", async () => {
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    try {
      fetchSessionsMock.mockResolvedValue({ sessions: [SERVER_SESSION] });
      fetchSessionExportMock.mockResolvedValue({
        exported_at: "2026-11-16T00:00:00.000Z",
        session: {
          id: "ses_1",
          title: "Which processes use CPU?",
          created_at: 1_700_000_000_000,
        },
        generations: [],
        runs: [],
      });
      render(<HistoryPanel />);
      fireEvent.click(
        await screen.findByRole("button", { name: /export session/i }),
      );
      await waitFor(() => {
        expect(fetchSessionExportMock).toHaveBeenCalledWith("ses_1");
      });
    } finally {
      clickSpy.mockRestore();
    }
  });
});
