import { createHash } from "node:crypto";

import Database from "better-sqlite3";

import type { Recipe, RunOrigin } from "@vbpf/schemas";

import { buildFtsQuery, extractKeywords } from "./retrieval.js";

export const SCHEMA_VERSION = 4;

export function applyPragmas(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  db.pragma("trusted_schema = OFF");
}

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  applyPragmas(db);
  return db;
}

export function closeDb(db: Database.Database): void {
  db.pragma("optimize");
  db.close();
}

function currentVersion(db: Database.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

function setVersion(db: Database.Database, version: number): void {
  db.pragma(`user_version = ${version}`);
}

function hasColumn(
  db: Database.Database,
  table: string,
  column: string,
): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return rows.some((row) => row.name === column);
}

// ADD COLUMN only when the column is absent; never try/catch DDL.
function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  ddl: string,
): void {
  if (!hasColumn(db, table, column)) db.exec(ddl);
}

function createTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS generations (
      id TEXT PRIMARY KEY,
      session_id TEXT REFERENCES sessions(id),
      prompt TEXT NOT NULL DEFAULT '',
      script TEXT NOT NULL DEFAULT '',
      chart_type TEXT,
      explanation TEXT,
      duration_s INTEGER,
      validation_status TEXT,
      attempts INTEGER NOT NULL DEFAULT 1,
      model TEXT,
      based_on_recipe TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      generation_id TEXT REFERENCES generations(id),
      script_sha256 TEXT NOT NULL DEFAULT '',
      script_text TEXT NOT NULL DEFAULT '',
      duration_s INTEGER NOT NULL DEFAULT 10,
      state TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      events_count INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      dropped INTEGER NOT NULL DEFAULT 0,
      exit_reason TEXT,
      origin TEXT NOT NULL DEFAULT 'edited'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS recipes_index USING fts5(
      id, title, description, tags, view
    );
  `);
}

// v1: generations gained warnings/refusal/latency_ms after release.
function migrateTo1(db: Database.Database): void {
  addColumnIfMissing(
    db,
    "generations",
    "warnings",
    "ALTER TABLE generations ADD COLUMN warnings TEXT NOT NULL DEFAULT '[]'",
  );
  addColumnIfMissing(
    db,
    "generations",
    "refusal",
    "ALTER TABLE generations ADD COLUMN refusal TEXT",
  );
  addColumnIfMissing(
    db,
    "generations",
    "latency_ms",
    "ALTER TABLE generations ADD COLUMN latency_ms INTEGER NOT NULL DEFAULT 0",
  );
}

// v2: explanations cache (R-12).
function migrateTo2(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS explanations (
      script_sha256 TEXT PRIMARY KEY,
      explanation TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
  `);
}

// v3: runs linked to the confirmed generation (R-18).
function migrateTo3(db: Database.Database): void {
  addColumnIfMissing(
    db,
    "runs",
    "generation_id",
    "ALTER TABLE runs ADD COLUMN generation_id TEXT",
  );
  addColumnIfMissing(
    db,
    "runs",
    "script_sha256",
    "ALTER TABLE runs ADD COLUMN script_sha256 TEXT NOT NULL DEFAULT ''",
  );
  addColumnIfMissing(
    db,
    "runs",
    "edited",
    "ALTER TABLE runs ADD COLUMN edited INTEGER NOT NULL DEFAULT 0",
  );
}

// v4: explicit run provenance (I-14). Backfills generation-bound pristine
// rows from the generation (recipe when the generation names one, generated
// otherwise); every other legacy row keeps the 'edited' default.
function migrateTo4(db: Database.Database): void {
  addColumnIfMissing(
    db,
    "runs",
    "origin",
    "ALTER TABLE runs ADD COLUMN origin TEXT NOT NULL DEFAULT 'edited'",
  );
  db.exec(`
    UPDATE runs SET origin = 'generated'
    WHERE generation_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM generations g
      WHERE g.id = runs.generation_id
        AND g.script = runs.script_text
        AND g.based_on_recipe IS NULL
    );
    UPDATE runs SET origin = 'recipe'
    WHERE generation_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM generations g
      WHERE g.id = runs.generation_id
        AND g.script = runs.script_text
        AND g.based_on_recipe IS NOT NULL
    );
  `);
}

export function migrate(db: Database.Database): void {
  applyPragmas(db);
  const found = currentVersion(db);
  if (found > SCHEMA_VERSION) {
    throw new Error(
      `unsupported schema version ${found} (latest known: ${SCHEMA_VERSION})`,
    );
  }
  createTables(db);
  const steps = [migrateTo1, migrateTo2, migrateTo3, migrateTo4];
  for (let i = found; i < steps.length; i++) {
    const run = steps[i]!;
    db.transaction(run)(db);
    setVersion(db, i + 1);
  }
}

export function indexRecipes(db: Database.Database, recipes: Recipe[]): void {
  const del = db.prepare("DELETE FROM recipes_index");
  const ins = db.prepare(
    "INSERT INTO recipes_index (id, title, description, tags, view) VALUES (?, ?, ?, ?, ?)",
  );
  const tx = db.transaction((rows: Recipe[]) => {
    del.run();
    for (const r of rows) {
      ins.run(r.id, r.title, r.description, r.tags.join(" "), r.view);
    }
  });
  tx(recipes);
}

function escapeFts(query: string): string {
  return query
    .replace(/\0/g, " ")
    .replace(/["*]/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function toRecipe(row: Omit<Recipe, "tags"> & { tags: string }): Recipe {
  return { ...row, tags: row.tags === "" ? [] : row.tags.split(" ") };
}

export function searchRecipes(
  db: Database.Database,
  query: string,
  limit = 50,
): Recipe[] {
  const q = query.trim();
  if (q === "") {
    const rows = db
      .prepare(
        "SELECT id, title, description, tags, view FROM recipes_index ORDER BY id LIMIT ?",
      )
      .all(limit) as Array<Omit<Recipe, "tags"> & { tags: string }>;
    return rows.map(toRecipe);
  }
  const safe = escapeFts(q);
  if (safe === "") {
    const rows = db
      .prepare(
        "SELECT id, title, description, tags, view FROM recipes_index ORDER BY id LIMIT ?",
      )
      .all(limit) as Array<Omit<Recipe, "tags"> & { tags: string }>;
    return rows.map(toRecipe);
  }
  const match = buildFtsQuery(extractKeywords(safe));
  if (match === "") {
    const rows = db
      .prepare(
        "SELECT id, title, description, tags, view FROM recipes_index ORDER BY id LIMIT ?",
      )
      .all(limit) as Array<Omit<Recipe, "tags"> & { tags: string }>;
    return rows.map(toRecipe);
  }
  const rows = db
    .prepare(
      "SELECT id, title, description, tags, view FROM recipes_index WHERE recipes_index MATCH ? ORDER BY rank LIMIT ?",
    )
    .all(match, limit) as Array<Omit<Recipe, "tags"> & { tags: string }>;
  return rows.map(toRecipe);
}

export interface ExplanationRow {
  script_sha256: string;
  explanation: string;
  model: string;
}

export function getExplanation(
  db: Database.Database,
  scriptSha256: string,
): ExplanationRow | undefined {
  const row = db
    .prepare(
      "SELECT script_sha256, explanation, model FROM explanations WHERE script_sha256 = ?",
    )
    .get(scriptSha256) as ExplanationRow | undefined;
  return row;
}

export function putExplanation(
  db: Database.Database,
  row: ExplanationRow,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO explanations
      (script_sha256, explanation, model, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(row.script_sha256, row.explanation, row.model, Date.now());
}

export interface GenerationRow {
  id: string;
  session_id: string;
  prompt: string;
  script: string;
  chart_type: string | null;
  explanation: string | null;
  duration_s: number | null;
  validation_status: string;
  attempts: number;
  model: string | null;
  based_on_recipe: string | null;
  warnings: string;
  refusal: string | null;
  latency_ms: number;
}

export function ensureSession(db: Database.Database, sessionId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO sessions (id, title, created_at) VALUES (?, '', ?)",
  ).run(sessionId, Date.now());
}

export function insertGeneration(
  db: Database.Database,
  row: GenerationRow,
): void {
  db.prepare(
    `INSERT INTO generations
      (id, session_id, prompt, script, chart_type, explanation, duration_s,
       validation_status, attempts, model, based_on_recipe, warnings, refusal,
       latency_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.session_id,
    row.prompt,
    row.script,
    row.chart_type,
    row.explanation,
    row.duration_s,
    row.validation_status,
    row.attempts,
    row.model,
    row.based_on_recipe,
    row.warnings,
    row.refusal,
    row.latency_ms,
    Date.now(),
  );
}

export function generationExists(db: Database.Database, id: string): boolean {
  const row = db.prepare("SELECT 1 FROM generations WHERE id = ?").get(id);
  return row !== undefined;
}

export function getGeneration(
  db: Database.Database,
  id: string,
): { id: string; script: string; based_on_recipe: string | null } | undefined {
  return db
    .prepare("SELECT id, script, based_on_recipe FROM generations WHERE id = ?")
    .get(id) as
    { id: string; script: string; based_on_recipe: string | null } | undefined;
}

// Run provenance (I-14), derived server-side. A generation binding decides
// first: the run is generated when the script is byte-identical to the
// generation (a stock echo counts as recipe when the generation names one),
// edited when the user changed it. Without a generation, a script whose
// hash matches the recipe library is a stock recipe run; anything else is a
// hand-supplied script and reads as edited. recipeHashes holds sha256 of
// trimmed recipe bodies (trailing-newline robust, mirroring the explain
// mock); the caller builds it once from the recipe library.
export function deriveRunOrigin(args: {
  generation: { script: string; based_on_recipe: string | null } | undefined;
  script: string;
  recipeHashes: Set<string>;
}): RunOrigin {
  if (args.generation !== undefined) {
    if (args.script !== args.generation.script) return "edited";
    return args.generation.based_on_recipe !== null ? "recipe" : "generated";
  }
  return args.recipeHashes.has(sha256Hex(args.script.trim()))
    ? "recipe"
    : "edited";
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface RunInsertRow {
  id: string;
  generation_id: string | null;
  script_sha256: string;
  script_text: string;
  edited: boolean | number;
  origin: RunOrigin;
  duration_s: number;
  state: string;
  started_at: number;
}

export function insertRun(db: Database.Database, run: RunInsertRow): void {
  db.prepare(
    "INSERT INTO runs (id, generation_id, script_sha256, script_text, edited, origin, duration_s, state, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    run.id,
    run.generation_id,
    run.script_sha256,
    run.script_text,
    run.edited ? 1 : 0,
    run.origin,
    run.duration_s,
    run.state,
    run.started_at,
  );
}

export interface RunSummaryUpdate {
  events: number;
  bytes: number;
  dropped: number;
  exit_reason: string;
}

export function persistRunSummary(
  db: Database.Database,
  runId: string,
  summary: RunSummaryUpdate,
): void {
  if (!db.open) return;
  const state =
    summary.exit_reason === "completed" || summary.exit_reason === "timeout"
      ? "completed"
      : summary.exit_reason === "cancelled"
        ? "stopping"
        : "failed";
  // Idempotent: only a non-terminal row (running/stopping) accepts a summary,
  // so a late duplicate (viewer relay vs monitor) cannot clobber the first.
  db.prepare(
    "UPDATE runs SET state = ?, ended_at = ?, events_count = ?, bytes = ?, dropped = ?, exit_reason = ? WHERE id = ? AND state IN ('running', 'stopping')",
  ).run(
    state,
    Date.now(),
    summary.events,
    summary.bytes,
    summary.dropped,
    summary.exit_reason,
    runId,
  );
}

// Fails a run with an explicit exit reason (monitor_timeout, api_restart).
// Like persistRunSummary, only non-terminal rows are touched.
export function failRunWithReason(
  db: Database.Database,
  runId: string,
  exitReason: string,
): boolean {
  if (!db.open) return false;
  const res = db
    .prepare(
      "UPDATE runs SET state = 'failed', ended_at = ?, exit_reason = ? WHERE id = ? AND state IN ('running', 'stopping')",
    )
    .run(Date.now(), exitReason, runId);
  return res.changes > 0;
}

export interface UnfinishedRun {
  id: string;
  duration_s: number;
  started_at: number;
}

// Rows the monitor still owns: running, plus stopping (a stop was requested
// but the agent's terminal summary never arrived).
export function listUnfinishedRuns(db: Database.Database): UnfinishedRun[] {
  if (!db.open) return [];
  return db
    .prepare(
      "SELECT id, duration_s, started_at FROM runs WHERE state IN ('running', 'stopping')",
    )
    .all() as UnfinishedRun[];
}

export function markRunFailedIfActive(
  db: Database.Database,
  runId: string,
): boolean {
  if (!db.open) return false;
  // stopping is not terminal: a requested stop still awaits the agent's
  // summary, so a dead stream must fail it too.
  const res = db
    .prepare(
      "UPDATE runs SET state = 'failed', ended_at = ? WHERE id = ? AND state IN ('running', 'stopping')",
    )
    .run(Date.now(), runId);
  return res.changes > 0;
}
