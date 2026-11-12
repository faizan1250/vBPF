// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DemoBanner } from "./DemoBanner.js";

describe("DemoBanner", () => {
  afterEach(() => {
    cleanup();
  });

  it("names the demo as recorded and non-executing", () => {
    render(<DemoBanner />);
    expect(
      screen.getByText("Demo mode: recorded data, nothing is executed", {
        exact: true,
      }),
    ).toBeInTheDocument();
  });
});
