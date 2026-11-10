// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../store/useAppStore.js";
import { ScriptPanel } from "./ScriptPanel.js";

vi.mock("@monaco-editor/react", () => ({
  default: ({ value }: { value?: string }) => (
    <textarea aria-label="Mock Monaco" readOnly value={value ?? ""} />
  ),
}));

vi.mock("../lib/monaco.js", () => ({
  configureMonaco: async () => undefined,
}));

vi.mock("./ExplainSection.js", () => ({
  ExplainSection: () => <div>ExplainSection stub</div>,
}));

describe("ScriptPanel", () => {
  beforeEach(() => {
    useAppStore.setState({
      generation: {
        generation_id: "gen_1",
        script: "tracepoint:sched:* { @c[probe] = count(); }",
        chart_type: "bar",
        explanation: "Counts scheduler tracepoints.",
        duration_s: 10,
        warnings: [],
        validation: { status: "ok", attempts: 1, errors: [] },
        based_on_recipe: null,
      },
      script: "tracepoint:sched:* { @c[probe] = count(); }",
      validationOk: true,
      validationErrors: [],
      validationProbes: ["tracepoint:sched:*"],
      validationWarnings: [],
      validationProbeCount: 12,
      validationCode: null,
      validationFixHint: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("displays 'expands to N probes' when wildcard validation reports expanded count", () => {
    render(<ScriptPanel validating={false} />);
    expect(screen.getByText(/expands to 12 probes/i)).toBeInTheDocument();
  });

  it("does not display expansion count for a single literal probe", () => {
    useAppStore.setState({
      validationProbes: ["BEGIN"],
      validationProbeCount: 1,
    });
    render(<ScriptPanel validating={false} />);
    expect(screen.getByText(/probes: BEGIN/)).toBeInTheDocument();
    expect(screen.queryByText(/expands to/i)).not.toBeInTheDocument();
  });

  it("surfaces live hot libc validation warnings and AGENT_NOT_READY fix hints", () => {
    useAppStore.setState({
      script: "uprobe:libc:malloc { @c = count(); }",
      validationOk: false,
      validationErrors: ["AGENT_NOT_READY: agent probe catalog not ready"],
      validationWarnings: [
        'Hot libc symbol "malloc" fires at high frequency; rely on in-kernel aggregation and agent rate caps.',
      ],
      validationFixHint: "Mount debugfs/tracefs and retry.",
    });
    render(<ScriptPanel validating={false} />);
    expect(screen.getByText(/Hot libc symbol "malloc"/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Mount debugfs\/tracefs and retry\./i),
    ).toBeInTheDocument();
  });
});
