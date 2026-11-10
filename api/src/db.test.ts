import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrate } from "./db.js";

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
      "INSERT INTO runs (id, generation_id, script_text, edited, started_at) VALUES (?, ?, ?, ?, ?)",
    ).run("r1", "gen_x", "BEGIN {}", 1, 1);
    const row = db
      .prepare("SELECT generation_id, edited FROM runs WHERE id = ?")
      .get("r1") as { generation_id: string; edited: number };
    expect(row).toEqual({ generation_id: "gen_x", edited: 1 });
    // Idempotent: second migrate is a no-op.
    migrate(db);
    db.close();
  });
});
