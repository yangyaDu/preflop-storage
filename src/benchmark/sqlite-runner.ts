import { Database } from "bun:sqlite";
import { quoteIdentifier } from "../db/naming";
import {
  type BatchBenchmarkItem,
  type ColdStartResult,
  getMemorySnapshot,
  type DrillBenchmarkItem,
  type FullRangeBenchmarkItem,
  type HandBenchmarkItem,
} from "./common";

interface QueryLike {
  all: (...params: unknown[]) => unknown[];
}

export class SqliteBenchmarkRunner {
  private readonly db: Database;
  private readonly handStatements = new Map<string, QueryLike>();
  private readonly fullRangeStatements = new Map<string, QueryLike>();
  private readonly drillStatements = new Map<string, QueryLike>();
  private readonly concreteStatements = new Map<string, QueryLike>();

  constructor(sourceDbPath: string) {
    this.db = new Database(sourceDbPath, { readonly: true });
  }

  getHandStrategy(item: HandBenchmarkItem): number {
    return this.getHandStatement(item).all(item.concreteLineId, item.holeCards).length;
  }

  getFullRange(item: FullRangeBenchmarkItem): number {
    return this.getFullRangeStatement(item).all(item.concreteLineId).length;
  }

  getDrillScenarioHandStrategies(item: DrillBenchmarkItem): number {
    const abstractLines = this.getDrillStatement(item).all(item.drillName, item.playerCount, item.drillDepth) as Array<{
      abstract_line: string;
    }>;

    let resultCount = 0;
    const concreteStatement = this.getConcreteStatement(item);
    for (const abstractLine of abstractLines) {
      const concreteLines = concreteStatement.all(abstractLine.abstract_line) as Array<{ concrete_line_id: number }>;
      for (const concreteLine of concreteLines) {
        resultCount += this.getHandStrategy({
          strategy: item.strategy,
          playerCount: item.playerCount,
          depthBb: item.depthBb,
          concreteLineId: concreteLine.concrete_line_id,
          holeCards: item.holeCards,
        });
      }
    }

    return resultCount;
  }

  getHandStrategiesBatch(item: BatchBenchmarkItem): number {
    const statement = this.getHandStatement(item);
    let resultCount = 0;

    for (const request of item.requests) {
      resultCount += statement.all(request.concreteLineId, request.holeCards).length;
    }

    return resultCount;
  }

  close(): void {
    this.db.close();
  }

  private getHandStatement(item: Pick<HandBenchmarkItem, "strategy" | "playerCount" | "depthBb">): QueryLike {
    const tableName = getRangeTableName(item);
    const cached = this.handStatements.get(tableName);
    if (cached) return cached;

    const statement = this.db.query(`
      SELECT action_name, action_size, amount_bb, frequency, hand_ev
      FROM ${quoteIdentifier(tableName)}
      WHERE concrete_line_id = ?
        AND hole_cards = ?
      ORDER BY action_name, action_size, amount_bb
    `) as QueryLike;

    this.handStatements.set(tableName, statement);
    return statement;
  }

  private getFullRangeStatement(item: FullRangeBenchmarkItem): QueryLike {
    const tableName = getRangeTableName(item);
    const cached = this.fullRangeStatements.get(tableName);
    if (cached) return cached;

    const statement = this.db.query(`
      SELECT hole_cards, action_name, action_size, amount_bb, frequency, hand_ev
      FROM ${quoteIdentifier(tableName)}
      WHERE concrete_line_id = ?
      ORDER BY hole_cards, action_name, action_size, amount_bb
    `) as QueryLike;

    this.fullRangeStatements.set(tableName, statement);
    return statement;
  }

  private getDrillStatement(item: DrillBenchmarkItem): QueryLike {
    const tableName = `drill_scenario_lines_${item.strategy}`;
    const cached = this.drillStatements.get(tableName);
    if (cached) return cached;

    const statement = this.db.query(`
      SELECT abstract_line
      FROM ${quoteIdentifier(tableName)}
      WHERE drill_name = ?
        AND player_count = ?
        AND depth = ?
      ORDER BY abstract_line
    `) as QueryLike;

    this.drillStatements.set(tableName, statement);
    return statement;
  }

  private getConcreteStatement(item: Pick<HandBenchmarkItem, "strategy" | "playerCount" | "depthBb">): QueryLike {
    const tableName = getConcreteTableName(item);
    const cached = this.concreteStatements.get(tableName);
    if (cached) return cached;

    const statement = this.db.query(`
      SELECT id AS concrete_line_id
      FROM ${quoteIdentifier(tableName)}
      WHERE abstract_line = ?
      ORDER BY id
    `) as QueryLike;

    this.concreteStatements.set(tableName, statement);
    return statement;
  }
}

export function measureSqliteColdStart(sourceDbPath: string, item: HandBenchmarkItem | undefined): ColdStartResult | null {
  if (!item) return null;

  const memoryBefore = getMemorySnapshot();
  const start = performance.now();
  const runner = new SqliteBenchmarkRunner(sourceDbPath);

  try {
    const resultCount = runner.getHandStrategy(item);
    return {
      operation: "open SQLite and run first hand query",
      totalMs: performance.now() - start,
      resultCount,
      memoryBefore,
      memoryAfter: getMemorySnapshot(),
    };
  } finally {
    runner.close();
  }
}

function getRangeTableName(item: Pick<HandBenchmarkItem, "strategy" | "playerCount" | "depthBb">): string {
  return `range_data_${item.strategy}_${item.playerCount}max_${item.depthBb}BB`;
}

function getConcreteTableName(item: Pick<HandBenchmarkItem, "strategy" | "playerCount" | "depthBb">): string {
  return `concrete_lines_${item.strategy}_${item.playerCount}max_${item.depthBb}BB`;
}
