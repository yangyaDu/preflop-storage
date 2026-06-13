import { Database } from "bun:sqlite";
import {
  dimensionKey,
  getBinFileName,
  getConcreteLinesTableName,
  getRangePackIndexTableName,
  getDrillScenarioTableName,
  quoteIdentifier,
} from "../../db/naming";

export interface ConcreteLineRow {
  concrete_line_id: number;
  abstract_line: string;
  concrete_line: string;
}

export interface RangePackIndexRow {
  player_count: number;
  depth_bb: number;
  concrete_line_id: number;
  action_schema_id: number;
  hand_count: number;
  offset: number;
  byte_length: number;
  checksum: number;
  bin_file: string;
}

export interface ActionSchemaRow {
  id: number;
  action_count: number;
  action_blob: Uint8Array;
  checksum: number;
}

export class MetaDb {
  private readonly db: Database;
  private readonly indexCache = new Map<string, Map<number, RangePackIndexRow>>();

  constructor(path: string, options: { readonly?: boolean } = {}) {
    this.db = new Database(path, { readonly: options.readonly ?? true });
  }

  getDrillScenarioLines(params: {
    strategy?: string;
    drillName: string;
    playerCount: number;
    drillDepth?: number;
  }): string[] {
    const tableName = quoteIdentifier(getDrillScenarioTableName(params.strategy ?? "default"));
    const rows = this.db
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

  getConcreteLines(params: {
    strategy?: string;
    playerCount: number;
    depthBb: number;
    abstractLine: string;
  }): ConcreteLineRow[] {
    const tableName = quoteIdentifier(
      getConcreteLinesTableName(params.strategy ?? "default", params.playerCount, params.depthBb),
    );
    return this.db
      .query(`
        SELECT concrete_line_id, abstract_line, concrete_line
        FROM ${tableName}
        WHERE abstract_line = ?
        ORDER BY concrete_line_id
      `)
      .all(params.abstractLine) as ConcreteLineRow[];
  }

  getRangePackIndex(params: {
    strategy?: string;
    playerCount: number;
    depthBb: number;
    concreteLineId: number;
  }): RangePackIndexRow | null {
    const strategy = params.strategy ?? "default";
    const map = this.loadIndexCache(strategy, params.playerCount, params.depthBb);
    return map.get(params.concreteLineId) ?? null;
  }

  getRangePackIndexBatch(params: {
    strategy?: string;
    playerCount: number;
    depthBb: number;
    concreteLineIds: number[];
  }): RangePackIndexRow[] {
    if (params.concreteLineIds.length === 0) return [];

    const strategy = params.strategy ?? "default";
    const map = this.loadIndexCache(strategy, params.playerCount, params.depthBb);

    const result: RangePackIndexRow[] = [];
    for (const id of params.concreteLineIds) {
      const row = map.get(id);
      if (row) result.push(row);
    }
    return result;
  }

  getActionSchema(actionSchemaId: number): ActionSchemaRow | null {
    const row = this.db
      .query(`
        SELECT id, action_count, action_blob, checksum
        FROM action_schemas
        WHERE id = ?
      `)
      .get(actionSchemaId) as ActionSchemaRow | null;

    if (!row) return null;
    return {
      ...row,
      action_blob: new Uint8Array(row.action_blob.buffer, row.action_blob.byteOffset, row.action_blob.byteLength),
    };
  }

  close(): void {
    this.indexCache.clear();
    this.db.close();
  }

  public loadIndexCache(strategy: string, playerCount: number, depthBb: number): Map<number, RangePackIndexRow> {
    const key = dimensionKey({ strategy, playerCount, depthBb });
    const cached = this.indexCache.get(key);
    if (cached) return cached;

    const tableName = quoteIdentifier(getRangePackIndexTableName(strategy, playerCount, depthBb));
    const binFile = getBinFileName(strategy, playerCount, depthBb);

    const rows = this.db
      .query(`
        SELECT concrete_line_id, action_schema_id, hand_count, offset, byte_length, checksum
        FROM ${tableName}
      `)
      .all() as Array<Omit<RangePackIndexRow, "player_count" | "depth_bb" | "bin_file">>;

    const map = new Map<number, RangePackIndexRow>();
    for (const row of rows) {
      map.set(row.concrete_line_id, {
        ...row,
        player_count: playerCount,
        depth_bb: depthBb,
        bin_file: binFile,
      });
    }

    this.indexCache.set(key, map);
    return map;
  }
}
