// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { EventEnvelope } from "../../lib/api.js";
import { TableView } from "./TableView.js";

function mapEvent(data: unknown): EventEnvelope {
  return { run_id: "r", seq: 1, ts: 1, kind: "map", data };
}

describe("TableView", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows an empty state without map snapshots", () => {
    render(<TableView events={[]} />);
    expect(screen.getByText(/no table rows yet/i)).toBeDefined();
  });

  it("lists latest snapshot keys sorted desc", () => {
    render(<TableView events={[mapEvent({ "@m": { bash: 2, init: 9 } })]} />);
    expect(screen.getByText("2 keys (latest snapshot)")).toBeDefined();
    const rows = screen.getAllByRole("row");
    expect(rows[1]!.textContent).toMatch(/init/);
    expect(rows[2]!.textContent).toMatch(/bash/);
  });
});
