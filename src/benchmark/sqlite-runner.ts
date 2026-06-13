import { Database } from "bun:sqlite";
import { quoteIdentifier } from "../db/naming";
import {
  type BatchBenchmarkItem,
  type ColdStartResult,
  getMemorySnapshot,
  type HandBenchmarkItem,
} from "./common";

interface QueryLike {
  all: (...params: unknown[]) => unknown[];
}

export class SqliteBenchmarkRunner {
  private readonly db: Database;
  private readonly handStatements = new Map<string, QueryLike>();

  constructor(sourceDbPath: string) {
    this.db = new Database(sourceDbPath, { readonly: true });
  }

  getHandStrategy(item: HandBenchmarkItem): number {
    return this.getHandStatement(item).all(item.concreteLineId, item.holeCards).length;
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

