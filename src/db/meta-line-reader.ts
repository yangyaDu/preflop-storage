import { Database } from "bun:sqlite";
import {
  getConcreteLinesTableName,
  getDrillScenarioTableName,
  quoteIdentifier,
} from "./naming";

export interface ConcreteLineRow {
  concrete_line_id: number;
  abstract_line: string;
  concrete_line: string;
}

export interface DrillScenarioLineQuery {
  strategy?: string;
  drillName: string;
  playerCount: number;
  drillDepth?: number;
}

export interface ConcreteLineQuery {
  strategy?: string;
  playerCount: number;
  depthBb: number;
  abstractLine: string;
}

export function getDrillScenarioLines(db: Database, params: DrillScenarioLineQuery): string[] {
  const tableName = quoteIdentifier(getDrillScenarioTableName(params.strategy ?? "default"));
  const rows = db
    .query(`
      SELECT abstract_line
      FROM ${tableName}
      WHERE drill_name = ?
        AND player_count = ?
        AND drill_depth = ?
      ORDER BY abstract_line
    `)
    .all(params.drillName, params.playerCount, params.drillDepth ?? 0) as Array<{
    abstract_line: string;
  }>;

  return rows.map((row) => row.abstract_line);
}

export function getConcreteLines(db: Database, params: ConcreteLineQuery): ConcreteLineRow[] {
  const tableName = quoteIdentifier(
    getConcreteLinesTableName(params.strategy ?? "default", params.playerCount, params.depthBb),
  );
  return db
    .query(`
      SELECT concrete_line_id, abstract_line, concrete_line
      FROM ${tableName}
      WHERE abstract_line = ?
      ORDER BY concrete_line_id
    `)
    .all(params.abstractLine) as ConcreteLineRow[];
}
