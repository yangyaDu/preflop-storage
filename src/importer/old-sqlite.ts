import { Database } from "bun:sqlite";
import { parseRangeDataTableName, type RangeDimension } from "../db/naming";

export function discoverRangeDimensions(db: Database): RangeDimension[] {
  const rangeTables = db
    .query("SELECT name FROM sqlite_master WHERE type = ? AND name LIKE ? ORDER BY name")
    .all("table", "range_data_%") as Array<{ name: string }>;

  const concreteTables = new Set(
    (
      db
        .query("SELECT name FROM sqlite_master WHERE type = ? AND name LIKE ?")
        .all("table", "concrete_lines_%") as Array<{ name: string }>
    ).map((row) => row.name),
  );

  return rangeTables
    .map((row) => parseRangeDataTableName(row.name))
    .filter((dimension): dimension is RangeDimension => Boolean(dimension))
    .filter((dimension) => concreteTables.has(dimension.concreteTable))
    .sort((left, right) => {
      const strategyDiff = left.strategy.localeCompare(right.strategy);
      if (strategyDiff !== 0) return strategyDiff;

      const playerDiff = left.playerCount - right.playerCount;
      if (playerDiff !== 0) return playerDiff;

      return left.depthBb - right.depthBb;
    });
}

export interface OldRangeRow {
  concrete_line_id: number;
  hole_cards: string;
  action_name: string;
  action_size: number;
  amount_bb: number;
  frequency: number;
  hand_ev: number | null;
}
