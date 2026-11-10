import type { CatalogState } from "@vbpf/schemas";
import { create } from "zustand";

import type { EventEnvelope, GenerateResponse } from "../lib/api.js";
import type { SummaryInfo, ViewKind } from "../lib/events.js";
import { MAX_DURATION_S, MIN_DURATION_S } from "../lib/api.js";

export type RunPhase =
  | "idle"
  | "generating"
  | "awaiting-confirm"
  | "starting"
  | "running"
  | "stopping"
  | "done"
  | "failed";

export const EVENT_RING_CAP = 5000;
export const STDERR_CAP = 500;

export interface ConfirmRequest {
  script: string;
  durationS: number;
  warnings: string[];
}

export interface ValidationMeta {
  warnings?: string[];
  probeCount?: number | null;
  code?: string | null;
  fixHint?: string | null;
}

interface AppState {
  prompt: string;
  durationS: number;
  sessionId: string;
  generation: GenerateResponse | null;
  script: string;
  validationOk: boolean | null;
  validationErrors: string[];
  validationProbes: string[];
  validationWarnings: string[];
  validationProbeCount: number | null;
  validationCode: string | null;
  validationFixHint: string | null;
  agentReady: boolean | null;
  agentCatalogState: CatalogState | null;
  agentStatusHint: string | null;
  confirmOpen: boolean;
  runPhase: RunPhase;
  runId: string | null;
  runError: string | null;
  events: EventEnvelope[];
  dropped: number;
  stderrLines: string[];
  summary: SummaryInfo | null;
  viewOverride: ViewKind | null;
  eventsPaused: boolean;
  historyVersion: number;

  setPrompt: (prompt: string) => void;
  setDuration: (durationS: number) => void;
  setGeneration: (generation: GenerateResponse | null) => void;
  setScript: (script: string) => void;
  setValidation: (
    ok: boolean | null,
    errors: string[],
    probes: string[],
    meta?: ValidationMeta,
  ) => void;
  setAgentStatus: (
    ready: boolean | null,
    catalogState?: CatalogState | null,
    hint?: string | null,
  ) => void;
  setConfirmOpen: (open: boolean) => void;
  setRunPhase: (phase: RunPhase) => void;
  setRunId: (runId: string | null) => void;
  setRunError: (error: string | null) => void;
  pushEvents: (incoming: EventEnvelope[]) => void;
  pushStderr: (line: string) => void;
  setSummary: (summary: SummaryInfo | null) => void;
  setViewOverride: (view: ViewKind | null) => void;
  setEventsPaused: (paused: boolean) => void;
  clearRun: () => void;
  bumpHistory: () => void;
  resetForGenerate: () => void;
}

function clampDuration(n: number): number {
  if (!Number.isFinite(n)) return 10;
  return Math.min(MAX_DURATION_S, Math.max(MIN_DURATION_S, Math.round(n)));
}

export const useAppStore = create<AppState>()((set) => ({
  prompt: "",
  durationS: 10,
  sessionId: "",
  generation: null,
  script: "",
  validationOk: null,
  validationErrors: [],
  validationProbes: [],
  validationWarnings: [],
  validationProbeCount: null,
  validationCode: null,
  validationFixHint: null,
  agentReady: null,
  agentCatalogState: null,
  agentStatusHint: null,
  confirmOpen: false,
  runPhase: "idle",
  runId: null,
  runError: null,
  events: [],
  dropped: 0,
  stderrLines: [],
  summary: null,
  viewOverride: null,
  eventsPaused: false,
  historyVersion: 0,

  setPrompt: (prompt) => set({ prompt }),
  setDuration: (durationS) => set({ durationS: clampDuration(durationS) }),
  setGeneration: (generation) =>
    set({
      generation,
      script: generation?.script ?? "",
      durationS: generation ? clampDuration(generation.duration_s) : 10,
      validationOk: generation ? generation.validation.status === "ok" : null,
      validationErrors: generation?.validation.errors ?? [],
      validationProbes: [],
      validationWarnings: [],
      validationProbeCount: null,
      validationCode: null,
      validationFixHint: null,
    }),
  setScript: (script) => set({ script }),
  setValidation: (ok, errors, probes, meta) =>
    set({
      validationOk: ok,
      validationErrors: errors,
      validationProbes: probes,
      validationWarnings: meta?.warnings ?? [],
      validationProbeCount: meta?.probeCount ?? null,
      validationCode: meta?.code ?? null,
      validationFixHint: meta?.fixHint ?? null,
    }),
  setAgentStatus: (ready, catalogState = null, hint = null) =>
    set({
      agentReady: ready,
      agentCatalogState: catalogState,
      agentStatusHint: hint,
    }),
  setConfirmOpen: (open) => set({ confirmOpen: open }),
  setRunPhase: (phase) => set({ runPhase: phase }),
  setRunId: (runId) => set({ runId }),
  setRunError: (error) => set({ runError: error }),
  pushEvents: (incoming) =>
    set((state) => {
      if (incoming.length === 0) return state;
      const merged = state.events.concat(incoming);
      const overflow = Math.max(0, merged.length - EVENT_RING_CAP);
      return {
        events: overflow > 0 ? merged.slice(overflow) : merged,
        dropped: state.dropped + overflow,
      };
    }),
  pushStderr: (line) =>
    set((state) => ({
      stderrLines: [...state.stderrLines, line].slice(-STDERR_CAP),
    })),
  setSummary: (summary) => set({ summary }),
  setViewOverride: (view) => set({ viewOverride: view }),
  setEventsPaused: (paused) => set({ eventsPaused: paused }),
  clearRun: () =>
    set({
      runPhase: "idle",
      runId: null,
      runError: null,
      events: [],
      dropped: 0,
      stderrLines: [],
      summary: null,
      viewOverride: null,
      eventsPaused: false,
    }),
  bumpHistory: () =>
    set((state) => ({ historyVersion: state.historyVersion + 1 })),
  resetForGenerate: () =>
    set({
      runPhase: "generating",
      runError: null,
      events: [],
      dropped: 0,
      stderrLines: [],
      summary: null,
      viewOverride: null,
      eventsPaused: false,
    }),
}));
