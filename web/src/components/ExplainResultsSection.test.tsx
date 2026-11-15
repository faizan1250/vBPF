// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, type ExplainResultsResult } from "../lib/api.js";
import { ExplainResultsSection } from "./ExplainResultsSection.js";

vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return { ...actual, explainResults: vi.fn(), fixtureMode: () => false };
});

const { explainResults } = await import("../lib/api.js");
const resultsMock = vi.mocked(explainResults);

const RESULT: ExplainResultsResult = {
  explanation: "bash did 42 opens.",
  cached: false,
  model: "mock",
};

const SCRIPT = "BEGIN { @x = count(); }";
const OUTPUT = "[#1 printf] hello";

describe("ExplainResultsSection", () => {
  afterEach(() => {
    cleanup();
    resultsMock.mockReset();
  });

  it("stays disabled until the consent box is checked", () => {
    render(<ExplainResultsSection script={SCRIPT} output={OUTPUT} />);
    const button = screen.getByRole("button", {
      name: /explain these results/i,
    });
    expect(button).toBeDisabled();
    expect(screen.getByText(/will leave this machine/i)).toBeInTheDocument();
    fireEvent.click(button);
    expect(resultsMock).not.toHaveBeenCalled();
  });

  it("sends script plus output only after opt-in", async () => {
    resultsMock.mockResolvedValue(RESULT);
    render(<ExplainResultsSection script={SCRIPT} output={OUTPUT} />);
    fireEvent.click(screen.getByLabelText(/will leave this machine/i));
    fireEvent.click(
      screen.getByRole("button", { name: /explain these results/i }),
    );
    expect(resultsMock).toHaveBeenCalledWith(SCRIPT, OUTPUT);
    expect(await screen.findByText("bash did 42 opens.")).toBeInTheDocument();
  });

  it("shows an error state with retry", async () => {
    resultsMock.mockRejectedValue(
      new ApiError(422, "VALIDATION_FAILED", "blocked call"),
    );
    render(<ExplainResultsSection script={SCRIPT} output={OUTPUT} />);
    fireEvent.click(screen.getByLabelText(/will leave this machine/i));
    fireEvent.click(
      screen.getByRole("button", { name: /explain these results/i }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("VALIDATION_FAILED");
    expect(
      screen.getByRole("button", { name: /retry results explanation/i }),
    ).toBeInTheDocument();
  });

  it("invalidates the walkthrough when output changes", async () => {
    resultsMock.mockResolvedValue(RESULT);
    const { rerender } = render(
      <ExplainResultsSection script={SCRIPT} output={OUTPUT} />,
    );
    fireEvent.click(screen.getByLabelText(/will leave this machine/i));
    fireEvent.click(
      screen.getByRole("button", { name: /explain these results/i }),
    );
    expect(await screen.findByText("bash did 42 opens.")).toBeInTheDocument();
    rerender(<ExplainResultsSection script={SCRIPT} output="[#2 map] new" />);
    expect(screen.queryByText("bash did 42 opens.")).not.toBeInTheDocument();
  });
});
