import { Database } from "bun:sqlite";

export interface ConcreteLineRow {
  concrete_line_id: number;
  abstract_line: string;
  concrete_line: string;
}

export interface RangePackIndexRow {
  strategy: string;
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

  constructor(path: string, options: { readonly?: boolean } = {}) {
    this.db = new Database(path, { readonly: options.readonly ?? true });
  }

  getDrillScenarioLines(params: {
    strategy?: string;
    drillName: string;
    playerCount: number;
    drillDepth?: number;
  }): string[] {
    const rows = this.db
      .query(`
        SELECT abstract_line
        FROM drill_scenario_lines
        WHERE strategy = ?
          AND drill_name = ?
          AND player_count = ?
          AND drill_depth = ?
        ORDER BY abstract_line
      `)
      .all(params.strategy ?? "default", params.drillName, params.playerCount, params.drillDepth ?? 0) as Array<{
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
    return this.db
      .query(`
        SELECT concrete_line_id, abstract_line, concrete_line
        FROM concrete_lines
        WHERE strategy = ?
          AND player_count = ?
          AND depth_bb = ?
          AND abstract_line = ?
        ORDER BY concrete_line_id
      `)
      .all(params.strategy ?? "default", params.playerCount, params.depthBb, params.abstractLine) as ConcreteLineRow[];
  }

  getRangePackIndex(params: {
    strategy?: string;
    playerCount: number;
    depthBb: number;
    concreteLineId: number;
  }): RangePackIndexRow | null {
    return (this.db
      .query(`
        SELECT strategy, player_count, depth_bb, concrete_line_id, action_schema_id,
               hand_count, offset, byte_length, checksum, bin_file
        FROM range_pack_index
        WHERE strategy = ?
          AND player_count = ?
          AND depth_bb = ?
          AND concrete_line_id = ?
      `)
      .get(params.strategy ?? "default", params.playerCount, params.depthBb, params.concreteLineId) as
      | RangePackIndexRow
      | null);
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
    this.db.close();
  }
}
