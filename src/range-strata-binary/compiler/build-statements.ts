import { Database } from "bun:sqlite";
import {
  dimensionKey,
  getConcreteLinesTableName,
  getDrillScenarioTableName,
  quoteIdentifier,
  type RangeDimension,
} from "../../db/naming";

export interface BuildStatements {
  insertDrillLineByStrategy: Map<string, ReturnType<Database["prepare"]>>;
  insertConcreteLineByDimension: Map<string, ReturnType<Database["prepare"]>>;
  selectActionSchema: ReturnType<Database["prepare"]>;
  insertActionSchema: ReturnType<Database["prepare"]>;
  lastInsertId: ReturnType<Database["prepare"]>;
}

export function prepareBuildStatements(metaDb: Database, dimensions: RangeDimension[]): BuildStatements {
  const insertDrillLineByStrategy = new Map<string, ReturnType<Database["prepare"]>>();
  const insertConcreteLineByDimension = new Map<string, ReturnType<Database["prepare"]>>();

  const strategies = uniqueStrategies(dimensions);
  for (const strategy of strategies) {
    insertDrillLineByStrategy.set(
      strategy,
      metaDb.prepare(`
        INSERT OR IGNORE INTO ${quoteIdentifier(getDrillScenarioTableName(strategy))}(drill_name, abstract_line, player_count, drill_depth)
        VALUES (?, ?, ?, ?)
      `),
    );
  }

  for (const dimension of dimensions) {
    const { strategy, playerCount, depthBb } = dimension;
    insertConcreteLineByDimension.set(
      dimensionKey(dimension),
      metaDb.prepare(`
        INSERT OR IGNORE INTO ${quoteIdentifier(getConcreteLinesTableName(strategy, playerCount, depthBb))}(
          concrete_line_id, abstract_line, concrete_line
        )
        VALUES (?, ?, ?)
      `),
    );
  }

  return {
    insertDrillLineByStrategy,
    insertConcreteLineByDimension,
    selectActionSchema: metaDb.prepare("SELECT id FROM action_schemas WHERE schema_key = ?"),
    insertActionSchema: metaDb.prepare(`
      INSERT INTO action_schemas(action_count, action_blob, checksum, schema_key)
      VALUES (?, ?, ?, ?)
    `),
    lastInsertId: metaDb.prepare("SELECT last_insert_rowid() AS id"),
  };
}

export function finalizeBuildStatements(statements: BuildStatements | null): void {
  if (!statements) return;

  for (const statement of statements.insertDrillLineByStrategy.values()) {
    safeFinalizeStatement(statement);
  }
  for (const statement of statements.insertConcreteLineByDimension.values()) {
    safeFinalizeStatement(statement);
  }
  safeFinalizeStatement(statements.selectActionSchema);
  safeFinalizeStatement(statements.insertActionSchema);
  safeFinalizeStatement(statements.lastInsertId);
}

function uniqueStrategies(dimensions: RangeDimension[]): string[] {
  return [...new Set(dimensions.map((dimension) => dimension.strategy))];
}

function safeFinalizeStatement(statement: ReturnType<Database["prepare"]>): void {
  try {
    statement.finalize();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[build] Could not finalize a prepared statement before Database.close(): ${detail}`);
  }
}
