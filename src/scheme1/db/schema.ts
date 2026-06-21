import { Database } from "bun:sqlite";
import {
  getConcreteLinesTableName,
  getDrillScenarioTableName,
  getRangePackIndexTableName,
  quoteIdentifier,
  type RangeDimension,
} from "../../db/naming";

/**
 * @deprecated Scheme1 metadata schema is retained only for legacy compatibility.
 * Use the Range Strata Binary compiler for new builds.
 */
export function initBinaryMetaDb(
  db: Database,
  dimensions: Pick<RangeDimension, "strategy" | "playerCount" | "depthBb">[],
): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS build_info (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS action_schemas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_count INTEGER NOT NULL,
      action_blob BLOB NOT NULL,
      checksum INTEGER NOT NULL,
      schema_key TEXT NOT NULL UNIQUE
    );
  `);

  // drill_scenario_lines is per-strategy — deduplicate before iterating
  const seenStrategies = new Set<string>();
  for (const { strategy } of dimensions) {
    if (seenStrategies.has(strategy)) continue;
    seenStrategies.add(strategy);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${quoteIdentifier(getDrillScenarioTableName(strategy))} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        drill_name TEXT NOT NULL,
        abstract_line TEXT NOT NULL,
        player_count INTEGER NOT NULL,
        drill_depth INTEGER NOT NULL DEFAULT 0,
        UNIQUE(drill_name, player_count, drill_depth, abstract_line)
      );
    `);
  }

  // concrete_lines and range_pack_index are per-dimension
  for (const { strategy, playerCount, depthBb } of dimensions) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${quoteIdentifier(getConcreteLinesTableName(strategy, playerCount, depthBb))} (
        concrete_line_id INTEGER PRIMARY KEY,
        abstract_line TEXT NOT NULL,
        concrete_line TEXT NOT NULL,
        UNIQUE(abstract_line, concrete_line)
      );

      CREATE TABLE IF NOT EXISTS ${quoteIdentifier(getRangePackIndexTableName(strategy, playerCount, depthBb))} (
        concrete_line_id INTEGER PRIMARY KEY,
        action_schema_id INTEGER NOT NULL,
        hand_count INTEGER NOT NULL,
        offset INTEGER NOT NULL,
        byte_length INTEGER NOT NULL,
        checksum INTEGER NOT NULL
      );
    `);
  }
}
