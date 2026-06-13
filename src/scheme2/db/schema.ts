import { Database } from "bun:sqlite";
import {
  getDrillScenarioTableName,
  quoteIdentifier,
} from "./naming";

/**
 * 初始化方案二轻量 meta DB。
 *
 * 与方案一不同，方案二不创建 range_pack_index_* 表 —
 * 索引数据存储在独立的 .idx 文件中（mmap + 二分查找）。
 *
 * 方案二也不创建 concrete_lines_* 表 — 查询服务无需 ID → 名称映射，
 * 因为所有查询路径都是纯数值 ID：.idx 二分 → .bin 解码。
 */
export function initLightMetaDb(
  db: Database,
  dimensions: Array<{ strategy: string; playerCount: number; depthBb: number }>,
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
}
