export type CompatStatus = "verified" | "unverified" | "not-run";
export type CompatRecipeState =
  "available" | "fallback" | "unavailable" | "not-checked";

export interface CompatReportShape {
  env: string;
  status: CompatStatus;
  kernel: string;
  distro: string;
  bpftrace_version: string;
  btf: boolean;
  recorded_at?: string;
  recipes: Record<string, CompatRecipeState>;
  tests: {
    passed: string[];
    failed: string[];
  };
  notes: string;
}

export function validateReport(raw: unknown, file: string): CompatReportShape;
export function loadReports(dir?: string): CompatReportShape[];
export function statusCell(report: CompatReportShape): string;
export function renderReadmeSection(reports: CompatReportShape[]): string;
export function renderCompatMd(reports: CompatReportShape[]): string;
export function updateReadme(readme: string, section: string): string;
