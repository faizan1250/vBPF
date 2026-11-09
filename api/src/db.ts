import Database from "better-sqlite3";

import type { Recipe } from "@vbpf/schemas";

import { buildFtsQuery, extractKeywords } from "./retrieval.js";

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  return db;
}

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS generations (
      id TEXT PRIMARY KEY,
      session_id TEXT,
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
      generation_id TEXT,
      script_sha256 TEXT NOT NULL DEFAULT '',
      script_text TEXT NOT NULL DEFAULT '',
      duration_s INTEGER NOT NULL DEFAULT 10,
      state TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      events_count INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      dropped INTEGER NOT NULL DEFAULT 0,
      exit_reason TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS recipes_index USING fts5(
      id, title, description, tags, view
    );
    CREATE TABLE IF NOT EXISTS explanations (
      script_sha256 TEXT PRIMARY KEY,
      explanation TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
  `);
  for (const ddl of [
    "ALTER TABLE generations ADD COLUMN warnings TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE generations ADD COLUMN refusal TEXT",
    "ALTER TABLE generations ADD COLUMN latency_ms INTEGER NOT NULL DEFAULT 0",
  ]) {
    try {
      db.exec(ddl);
    } catch {
      // Column already exists from a previous migration.
    }
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
  return query.replace(/["*]/g, " ").trim().replace(/\s+/g, " ");
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
