// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EventEnvelope } from "../../lib/api.js";
import { useAppStore } from "../../store/useAppStore.js";
import { EventsView } from "./EventsView.js";

function envelope(seq: number): EventEnvelope {
  return { run_id: "r", seq, ts: seq, kind: "printf", data: `line ${seq}` };
}

describe("EventsView pause", () => {
  beforeEach(() => {
    useAppStore.setState({ eventsPaused: false });
  });
  afterEach(() => {
    cleanup();
    useAppStore.setState({ eventsPaused: false });
  });

  it("freezes rows while paused and goes live on resume", () => {
    const first = [envelope(0), envelope(1)];
    const grown = [...first, envelope(2), envelope(3)];
    const { rerender } = render(<EventsView events={first} />);
    expect(screen.getByText("2 events")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    rerender(<EventsView events={grown} />);
    expect(screen.getByText("2 events (paused)")).toBeDefined();
    expect(screen.queryByText("4 events")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    rerender(<EventsView events={grown} />);
    expect(screen.getByText("4 events")).toBeDefined();
  });
});
