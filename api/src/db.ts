import Database from "better-sqlite3";

import type { Recipe } from "@vbpf/schemas";

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
  `);
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
      .prepare("SELECT id, title, description, tags, view FROM recipes_index ORDER BY id LIMIT ?")
      .all(limit) as Array<Omit<Recipe, "tags"> & { tags: string }>;
    return rows.map(toRecipe);
  }
  const safe = escapeFts(q);
  if (safe === "") {
    const rows = db
      .prepare("SELECT id, title, description, tags, view FROM recipes_index ORDER BY id LIMIT ?")
      .all(limit) as Array<Omit<Recipe, "tags"> & { tags: string }>;
    return rows.map(toRecipe);
  }
  const match = safe
    .split(" ")
    .map((t) => `"${t}"`)
    .join(" OR ");
  const rows = db
    .prepare(
      "SELECT id, title, description, tags, view FROM recipes_index WHERE recipes_index MATCH ? ORDER BY rank LIMIT ?",
    )
    .all(match, limit) as Array<Omit<Recipe, "tags"> & { tags: string }>;
  return rows.map(toRecipe);
}
