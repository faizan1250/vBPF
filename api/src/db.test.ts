import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  closeDb,
  generationExists,
  getGeneration,
  insertRun,
  markRunFailedIfActive,
  migrate,
  openDb,
  persistRunSummary,
  SCHEMA_VERSION,
} from "./db.js";

describe("runs migration", () => {
  it("adds edited to a pre-r18 runs table", () => {
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE runs (id TEXT PRIMARY KEY, generation_id TEXT, script_sha256 TEXT NOT NULL DEFAULT '', script_text TEXT NOT NULL DEFAULT '', duration_s INTEGER NOT NULL DEFAULT 10, state TEXT NOT NULL DEFAULT 'running', started_at INTEGER NOT NULL, ended_at INTEGER, events_count INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, dropped INTEGER NOT NULL DEFAULT 0, exit_reason TEXT)",
    );
    migrate(db);
    const cols = (
      db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain("edited");
    expect(cols).toContain("generation_id");
    expect(cols).toContain("script_sha256");
    db.prepare(
      "INSERT INTO sessions (id, title, created_at) VALUES (?, '', ?)",
    ).run("s1", 1);
    db.prepare(
      "INSERT INTO generations (id, session_id, created_at) VALUES (?, ?, ?)",
    ).run("gen_x", "s1", 1);
    db.prepare(
      "INSERT INTO runs (id, generation_id, script_text, edited, started_at) VALUES (?, ?, ?, ?, ?)",
    ).run("r1", "gen_x", "BEGIN {}", 1, 1);
    const row = db
      .prepare("SELECT generation_id, edited FROM runs WHERE id = ?")
      .get("r1") as { generation_id: string; edited: number };
    expect(row).toEqual({ generation_id: "gen_x", edited: 1 });
    // Idempotent: second migrate is a no-op.
    migrate(db);
    closeDb(db);
  });
});

describe("connection pragmas", () => {
  it("sets hygiene pragmas on every connection", () => {
    // journal_mode needs a file; :memory: databases always report "memory".
    const dir = mkdtempSync(join(tmpdir(), "vbpf-r19-"));
    const db = openDb(join(dir, "pragmas.db"));
    try {
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
      expect(db.pragma("synchronous", { simple: true })).toBe(1);
      expect(db.pragma("trusted_schema", { simple: true })).toBe(0);
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    } finally {
      closeDb(db);
    }
  });

  it("runs optimize on close", () => {
    const db = openDb(":memory:");
    migrate(db);
    expect(() => closeDb(db)).not.toThrow();
    expect(db.open).toBe(false);
  });
});

describe("versioned migrations", () => {
  it("migrates a v0.1.0 database file", () => {
    const dir = mkdtempSync(join(tmpdir(), "vbpf-r19-"));
    const path = join(dir, "app.db");
    // Exact v0.1.0 shape: no user_version, no explanations table,
    // generations without warnings/refusal/latency_ms, runs without edited.
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE generations (
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
      CREATE TABLE runs (
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
      CREATE VIRTUAL TABLE recipes_index USING fts5(
        id, title, description, tags, view
      );
      INSERT INTO sessions (id, title, created_at) VALUES ('s1', '', 1);
      INSERT INTO generations (id, session_id, prompt, created_at)
        VALUES ('g1', 's1', 'p', 1);
      INSERT INTO runs (id, generation_id, script_text, started_at)
        VALUES ('r1', 'g1', 'BEGIN {}', 1);
    `);
    closeDb(legacy);

    const db = openDb(path);
    try {
      migrate(db);
      expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
      for (const col of ["warnings", "refusal", "latency_ms"]) {
        const rows = db
          .prepare("PRAGMA table_info(generations)")
          .all() as Array<{ name: string }>;
        expect(rows.map((r) => r.name)).toContain(col);
      }
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      expect(tables.map((t) => t.name)).toContain("explanations");
      // Legacy rows survive with backfilled defaults.
      const gen = db
        .prepare(
          "SELECT prompt, warnings, latency_ms FROM generations WHERE id = ?",
        )
        .get("g1") as { prompt: string; warnings: string; latency_ms: number };
      expect(gen).toEqual({ prompt: "p", warnings: "[]", latency_ms: 0 });
      const run = db
        .prepare("SELECT script_text, edited FROM runs WHERE id = ?")
        .get("r1") as { script_text: string; edited: number };
      expect(run).toEqual({ script_text: "BEGIN {}", edited: 0 });
      // Second migrate is a no-op.
      migrate(db);
      expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    } finally {
      closeDb(db);
    }
  });

  it("rejects a schema newer than this code", () => {
    const db = new Database(":memory:");
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    expect(() => migrate(db)).toThrow(/unsupported schema version/);
    closeDb(db);
  });
});

describe("foreign keys", () => {
  it("rejects children with missing parents", () => {
    const db = openDb(":memory:");
    try {
      migrate(db);
      expect(() =>
        db
          .prepare(
            "INSERT INTO generations (id, session_id, created_at) VALUES (?, ?, ?)",
          )
          .run("g_orphan", "no_such_session", 1),
      ).toThrow();
      db.prepare(
        "INSERT INTO sessions (id, title, created_at) VALUES (?, '', ?)",
      ).run("s1", 1);
      db.prepare(
        "INSERT INTO generations (id, session_id, created_at) VALUES (?, ?, ?)",
      ).run("g1", "s1", 1);
      expect(() =>
        db
          .prepare(
            "INSERT INTO runs (id, generation_id, started_at) VALUES (?, ?, ?)",
          )
          .run("r_orphan", "no_such_generation", 1),
      ).toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO runs (id, generation_id, started_at) VALUES (?, ?, ?)",
          )
          .run("r1", "g1", 1),
      ).not.toThrow();
    } finally {
      closeDb(db);
    }
  });
});

describe("run and generation helpers", () => {
  it("checks generation existence and retrieves generation script", () => {
    const db = openDb(":memory:");
    try {
      migrate(db);
      expect(generationExists(db, "gen_missing")).toBe(false);
      expect(getGeneration(db, "gen_missing")).toBeUndefined();

      db.prepare(
        "INSERT INTO sessions (id, title, created_at) VALUES (?, '', ?)",
      ).run("sess1", 1);
      db.prepare(
        "INSERT INTO generations (id, session_id, script, created_at) VALUES (?, ?, ?, ?)",
      ).run("gen_1", "sess1", "BEGIN { @x = count(); }", 1);

      expect(generationExists(db, "gen_1")).toBe(true);
      expect(getGeneration(db, "gen_1")).toEqual({
        id: "gen_1",
        script: "BEGIN { @x = count(); }",
      });
    } finally {
      closeDb(db);
    }
  });

  it("inserts run record correctly", () => {
    const db = openDb(":memory:");
    try {
      migrate(db);
      insertRun(db, {
        id: "run_abc",
        generation_id: null,
        script_sha256: "hash123",
        script_text: "BEGIN {}",
        edited: false,
        duration_s: 15,
        state: "running",
        started_at: 1000,
      });

      const row = db
        .prepare("SELECT * FROM runs WHERE id = ?")
        .get("run_abc") as {
        id: string;
        script_sha256: string;
        script_text: string;
        duration_s: number;
        state: string;
        edited: number;
      };
      expect(row).toMatchObject({
        id: "run_abc",
        script_sha256: "hash123",
        script_text: "BEGIN {}",
        duration_s: 15,
        state: "running",
        edited: 0,
      });
    } finally {
      closeDb(db);
    }
  });

  it("persists run summary and maps exit reasons to states", () => {
    const db = openDb(":memory:");
    try {
      migrate(db);
      insertRun(db, {
        id: "run_sum",
        generation_id: null,
        script_sha256: "h",
        script_text: "BEGIN {}",
        edited: false,
        duration_s: 10,
        state: "running",
        started_at: 100,
      });

      persistRunSummary(db, "run_sum", {
        events: 10,
        bytes: 200,
        dropped: 1,
        exit_reason: "completed",
      });

      const row = db
        .prepare("SELECT * FROM runs WHERE id = ?")
        .get("run_sum") as {
        state: string;
        events_count: number;
        bytes: number;
        dropped: number;
        exit_reason: string;
        ended_at: number;
      };
      expect(row).toMatchObject({
        state: "completed",
        events_count: 10,
        bytes: 200,
        dropped: 1,
        exit_reason: "completed",
      });
      expect(row.ended_at).toBeGreaterThan(0);
    } finally {
      closeDb(db);
    }
  });

  it("marks active runs as failed and is idempotent", () => {
    const db = openDb(":memory:");
    try {
      migrate(db);
      insertRun(db, {
        id: "run_fail",
        generation_id: null,
        script_sha256: "h",
        script_text: "BEGIN {}",
        edited: false,
        duration_s: 10,
        state: "running",
        started_at: 100,
      });

      expect(markRunFailedIfActive(db, "run_fail")).toBe(true);
      const row = db
        .prepare("SELECT state, ended_at FROM runs WHERE id = ?")
        .get("run_fail") as { state: string; ended_at: number };
      expect(row.state).toBe("failed");
      expect(row.ended_at).toBeGreaterThan(0);

      // Idempotent: second call returns false because state is not 'running'
      expect(markRunFailedIfActive(db, "run_fail")).toBe(false);

      // Does not alter completed runs
      insertRun(db, {
        id: "run_done",
        generation_id: null,
        script_sha256: "h",
        script_text: "BEGIN {}",
        edited: false,
        duration_s: 10,
        state: "completed",
        started_at: 100,
      });
      expect(markRunFailedIfActive(db, "run_done")).toBe(false);
      const doneRow = db
        .prepare("SELECT state FROM runs WHERE id = ?")
        .get("run_done") as { state: string };
      expect(doneRow.state).toBe("completed");
    } finally {
      closeDb(db);
    }
  });

  it("strips NUL bytes from FTS queries", async () => {
    const { searchRecipes } = await import("./db.js");
    const db = openDb(":memory:");
    try {
      migrate(db);
      expect(() => searchRecipes(db, "cpu\0\"*")).not.toThrow();
      expect(searchRecipes(db, "\0")).toEqual(searchRecipes(db, ""));
    } finally {
      closeDb(db);
    }
  });
});
