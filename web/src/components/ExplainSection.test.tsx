// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, type ExplainResult } from "../lib/api.js";
import { ExplainSection } from "./ExplainSection.js";

vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return { ...actual, explainScript: vi.fn(), fixtureMode: () => false };
});

const { explainScript } = await import("../lib/api.js");
const explainMock = vi.mocked(explainScript);

const RESULT: ExplainResult = {
  explanation: "Counts opens.",
  cached: false,
  model: "mock",
};

describe("ExplainSection", () => {
  afterEach(() => {
    cleanup();
    explainMock.mockReset();
  });

  it("shows loading then the walkthrough", async () => {
    let resolve!: (value: ExplainResult) => void;
    explainMock.mockReturnValue(
      new Promise<ExplainResult>((res) => {
        resolve = res;
      }),
    );
    render(<ExplainSection script="BEGIN { @x = count(); }" />);
    fireEvent.click(
      screen.getByRole("button", { name: /explain this probe/i }),
    );
    expect(await screen.findByText(/explaining/i)).toBeInTheDocument();
    expect(explainMock).toHaveBeenCalledWith("BEGIN { @x = count(); }");
    resolve(RESULT);
    expect(await screen.findByText("Counts opens.")).toBeInTheDocument();
    expect(screen.getByText(/via mock/)).toBeInTheDocument();
  });

  it("shows an error state with retry", async () => {
    explainMock.mockRejectedValue(
      new ApiError(422, "VALIDATION_FAILED", "blocked call"),
    );
    render(<ExplainSection script="BEGIN { @x = count(); }" />);
    fireEvent.click(
      screen.getByRole("button", { name: /explain this probe/i }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("VALIDATION_FAILED");
    expect(
      screen.getByRole("button", { name: /retry explanation/i }),
    ).toBeInTheDocument();
  });

  it("invalidates the walkthrough when the script is edited", async () => {
    explainMock.mockResolvedValue(RESULT);
    const { rerender } = render(
      <ExplainSection script="BEGIN { @x = count(); }" />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /explain this probe/i }),
    );
    expect(await screen.findByText("Counts opens.")).toBeInTheDocument();
    rerender(<ExplainSection script="BEGIN { @y = count(); }" />);
    expect(screen.queryByText("Counts opens.")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /explain this probe/i }),
    ).toBeInTheDocument();
  });
});
