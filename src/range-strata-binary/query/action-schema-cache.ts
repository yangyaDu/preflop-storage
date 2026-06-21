import { Database } from "bun:sqlite";
import { decodeActionSchema, type ActionDef } from "../../binary/action-schema-codec";
import { PreflopQueryError } from "../../query/errors";
import type { ActionSchemaRow } from "./types";

export class ActionSchemaCache {
  private readonly cache = new Map<number, ActionDef[]>();

  constructor(private readonly metaDb: Database) {}

  prewarm(actionSchemaIds?: Iterable<number>): number {
    if (actionSchemaIds) {
      let loaded = 0;
      for (const actionSchemaId of actionSchemaIds) {
        if (!this.cache.has(actionSchemaId)) {
          this.get(actionSchemaId);
          loaded += 1;
        }
      }
      return loaded;
    }

    const rows = this.metaDb
      .query(`
        SELECT id, action_count, action_blob
        FROM action_schemas
        ORDER BY id
      `)
      .all() as ActionSchemaRow[];

    let loaded = 0;
    for (const row of rows) {
      if (this.cache.has(row.id)) continue;
      this.cache.set(row.id, decodeActionSchemaRow(row));
      loaded += 1;
    }

    return loaded;
  }

  get(actionSchemaId: number): ActionDef[] {
    const cached = this.cache.get(actionSchemaId);
    if (cached) return cached;

    const schemaRow = this.metaDb
      .query(`
        SELECT id, action_count, action_blob
        FROM action_schemas
        WHERE id = ?
      `)
      .get(actionSchemaId) as ActionSchemaRow | null;

    if (!schemaRow) {
      throw new PreflopQueryError("ACTION_SCHEMA_NOT_FOUND", `Missing action schema: ${actionSchemaId}`, {
        actionSchemaId,
      });
    }

    const actions = decodeActionSchemaRow(schemaRow);
    this.cache.set(actionSchemaId, actions);
    return actions;
  }

  getCached(actionSchemaId: number): ActionDef[] | undefined {
    return this.cache.get(actionSchemaId);
  }
}

function decodeActionSchemaRow(schemaRow: ActionSchemaRow): ActionDef[] {
  const actionBlob = new Uint8Array(
    schemaRow.action_blob.buffer,
    schemaRow.action_blob.byteOffset,
    schemaRow.action_blob.byteLength,
  );
  return decodeActionSchema(actionBlob, schemaRow.action_count);
}
