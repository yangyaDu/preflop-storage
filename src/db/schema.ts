import { Database } from "bun:sqlite";

export function initBinaryMetaDb(db: Database): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS build_info (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS drill_scenario_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy TEXT NOT NULL,
      drill_name TEXT NOT NULL,
      abstract_line TEXT NOT NULL,
      player_count INTEGER NOT NULL,
      drill_depth INTEGER NOT NULL DEFAULT 0,
      UNIQUE(strategy, drill_name, abstract_line, player_count, drill_depth)
    );

    CREATE INDEX IF NOT EXISTS idx_drill_lookup
      ON drill_scenario_lines(strategy, drill_name, player_count, drill_depth);

    CREATE TABLE IF NOT EXISTS concrete_lines (
      strategy TEXT NOT NULL,
      player_count INTEGER NOT NULL,
      depth_bb INTEGER NOT NULL,
      concrete_line_id INTEGER NOT NULL,
      abstract_line TEXT NOT NULL,
      concrete_line TEXT NOT NULL,
      PRIMARY KEY(strategy, player_count, depth_bb, concrete_line_id),
      UNIQUE(strategy, player_count, depth_bb, abstract_line, concrete_line)
    );

    CREATE INDEX IF NOT EXISTS idx_concrete_lines_lookup
      ON concrete_lines(strategy, player_count, depth_bb, abstract_line);

    CREATE TABLE IF NOT EXISTS action_schemas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_count INTEGER NOT NULL,
      action_blob BLOB NOT NULL,
      checksum INTEGER NOT NULL,
      schema_key TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS range_pack_index (
      strategy TEXT NOT NULL,
      player_count INTEGER NOT NULL,
      depth_bb INTEGER NOT NULL,
      concrete_line_id INTEGER NOT NULL,
      action_schema_id INTEGER NOT NULL,
      hand_count INTEGER NOT NULL,
      offset INTEGER NOT NULL,
      byte_length INTEGER NOT NULL,
      checksum INTEGER NOT NULL,
      bin_file TEXT NOT NULL,
      PRIMARY KEY(strategy, player_count, depth_bb, concrete_line_id)
    );

    CREATE INDEX IF NOT EXISTS idx_range_pack_schema
      ON range_pack_index(action_schema_id);
  `);
}
