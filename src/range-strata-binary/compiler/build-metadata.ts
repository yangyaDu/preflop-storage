import { Database } from "bun:sqlite";
import { dimensionKey, quoteIdentifier, type RangeDimension } from "../../db/naming";
import { PreflopStoreError } from "../../query/errors";
import type { BuildStatements } from "./build-statements";

export function copyDrillScenarioLines(params: {
  sourceDb: Database;
  statements: BuildStatements;
  strategies: string[];
}): void {
  for (const strategy of params.strategies) {
    const table = `drill_scenario_lines_${strategy}`;
    const exists = params.sourceDb
      .query("SELECT 1 AS ok FROM sqlite_master WHERE type = ? AND name = ?")
      .get("table", table);
    if (!exists) continue;

    const rows = params.sourceDb
      .query(`
        SELECT drill_name, abstract_line, player_count, depth
        FROM ${quoteIdentifier(table)}
        ORDER BY id
      `)
      .iterate() as IterableIterator<{
      drill_name: string;
      abstract_line: string;
      player_count: number;
      depth: number;
    }>;

    const statement = params.statements.insertDrillLineByStrategy.get(strategy);
    if (!statement) throw new PreflopStoreError("BUILD_ERROR", `Missing drill insert statement for strategy ${strategy}`, { strategy });

    for (const row of rows) {
      statement.run(row.drill_name, row.abstract_line, row.player_count, row.depth);
    }
  }
}

export function copyConcreteLines(params: {
  sourceDb: Database;
  statements: BuildStatements;
  dimension: RangeDimension;
}): void {
  const key = dimensionKey(params.dimension);
  const statement = params.statements.insertConcreteLineByDimension.get(key);
  if (!statement) throw new PreflopStoreError("BUILD_ERROR", `Missing concrete insert statement for dimension ${key}`, { dimension: key });

  const rows = params.sourceDb
    .query(`
      SELECT id, abstract_line, concrete_line
      FROM ${quoteIdentifier(params.dimension.concreteTable)}
      ORDER BY id
    `)
    .iterate() as IterableIterator<{ id: number; abstract_line: string; concrete_line: string }>;

  for (const row of rows) {
    statement.run(row.id, row.abstract_line, row.concrete_line);
  }
}
