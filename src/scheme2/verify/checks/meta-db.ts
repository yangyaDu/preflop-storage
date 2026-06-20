import { Database } from "bun:sqlite";
import { join } from "node:path";
import { crc32c } from "../../../binary/crc32c";
import { getConcreteLinesTableName, getDrillScenarioTableName } from "../../db/naming";
import type { BuildManifest } from "../../importer/build-types";
import type { VerifyCheckResult, VerifyFailure } from "../report";

interface SchemaRow {
  id: number;
  action_count: number;
  action_blob: Buffer;
  checksum: number;
  schema_key: string;
}

export function checkMetaDb(dir: string, manifest: BuildManifest): VerifyCheckResult {
  const failures: VerifyFailure[] = [];
  const metaPath = join(dir, "meta.db");

  let db: Database;
  try {
    db = new Database(metaPath, { readonly: true });
  } catch {
    failures.push({
      layer: "meta-db",
      check: "open",
      reason: "IO_ERROR",
      message: `Cannot open meta.db at ${metaPath}`,
    });
    return { failures };
  }

  try {
    // ── build_info table existence ──────────────────────────
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
    const tableNames = new Set(tables.map((t) => t.name));

    if (!tableNames.has("build_info")) {
      failures.push({
        layer: "meta-db",
        check: "build_info",
        reason: "MISSING_TABLE",
        message: "Required table 'build_info' not found in meta.db",
      });
    } else {
      const buildInfoKeys = db
        .query("SELECT key, value FROM build_info WHERE key IN ('built_at', 'source_checksum')")
        .all() as Array<{ key: string; value: string }>;
      const haveBuiltAt = buildInfoKeys.some((r) => r.key === "built_at" && r.value);
      const haveSourceChecksum = buildInfoKeys.some((r) => r.key === "source_checksum" && r.value);
      if (!haveBuiltAt) {
        failures.push({
          layer: "meta-db",
          check: "build_info.built_at",
          reason: "MISSING_ROW",
          message: "build_info missing 'built_at' entry",
        });
      }
      if (!haveSourceChecksum) {
        failures.push({
          layer: "meta-db",
          check: "build_info.source_checksum",
          reason: "MISSING_ROW",
          message: "build_info missing 'source_checksum' entry",
        });
      }
    }

    // ── action_schemas table ───────────────────────────────
    if (!tableNames.has("action_schemas")) {
      failures.push({
        layer: "meta-db",
        check: "action_schemas",
        reason: "MISSING_TABLE",
        message: "Required table 'action_schemas' not found in meta.db",
      });
    } else {
      const schemas = db
        .query("SELECT id, action_count, action_blob, checksum, schema_key FROM action_schemas ORDER BY id")
        .all() as SchemaRow[];

      if (schemas.length === 0) {
        failures.push({
          layer: "meta-db",
          check: "action_schemas",
          reason: "EMPTY",
          message: "action_schemas table is empty",
        });
      }

      for (const schema of schemas) {
        const blob = new Uint8Array(
          schema.action_blob.buffer,
          schema.action_blob.byteOffset,
          schema.action_blob.byteLength,
        );

        // action_count consistency
        const expectedBlobLen = schema.action_count * 9;
        if (blob.byteLength !== expectedBlobLen) {
          failures.push({
            layer: "meta-db",
            check: "action_schemas",
            reason: "INVALID_FORMAT",
            message: `action_schema id=${schema.id}: blob length ${blob.byteLength} != action_count * 9 (${expectedBlobLen})`,
          });
        }

        // action_count bounds
        if (schema.action_count < 1 || schema.action_count > 32) {
          failures.push({
            layer: "meta-db",
            check: "action_schemas",
            reason: "INVALID_ARGUMENT",
            message: `action_schema id=${schema.id}: action_count=${schema.action_count} out of range [1, 32]`,
          });
        }

        // checksum == crc32c(action_blob)
        const actualChecksum = crc32c(blob);
        if (actualChecksum !== (schema.checksum >>> 0)) {
          failures.push({
            layer: "meta-db",
            check: "action_schemas",
            reason: "CHECKSUM_MISMATCH",
            message: `action_schema id=${schema.id}: stored checksum ${schema.checksum >>> 0} != computed ${actualChecksum}`,
          });
        }

        // schema_key == hex(action_blob)
        const hex = Array.from(blob)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        if (hex !== schema.schema_key) {
          failures.push({
            layer: "meta-db",
            check: "action_schemas",
            reason: "SCHEMA_KEY_MISMATCH",
            message: `action_schema id=${schema.id}: stored schema_key "${schema.schema_key}" != hex(blob)`,
          });
        }
      }
    }

    // ── drill_scenario_lines tables ────────────────────────
    const seenStrategies = new Set<string>();
    for (const dim of manifest.dimensions) {
      if (dim.status === "failed") continue;
      if (seenStrategies.has(dim.strategy)) continue;
      seenStrategies.add(dim.strategy);

      const drillTable = getDrillScenarioTableName(dim.strategy);
      if (!tableNames.has(drillTable)) {
        failures.push({
          layer: "meta-db",
          check: `drill:${dim.strategy}`,
          reason: "MISSING_TABLE",
          message: `Expected drill table "${drillTable}" not found`,
        });
      }
    }

    // ── concrete_lines tables ──────────────────────────────
    for (const dim of manifest.dimensions) {
      if (dim.status === "failed") continue;

      const concreteTable = getConcreteLinesTableName(dim.strategy, dim.playerCount, dim.depthBb);
      if (!tableNames.has(concreteTable)) {
        failures.push({
          layer: "meta-db",
          check: `concrete_lines:${dim.strategy}:${dim.playerCount}max:${dim.depthBb}BB`,
          reason: "MISSING_TABLE",
          message: `Expected concrete_lines table "${concreteTable}" not found`,
        });
      }
    }
  } finally {
    db.close();
  }

  return { failures };
}

/**
 * Extract the set of valid actionSchemaIds from meta.db.
 * Separate function so idx checks can call it independently.
 */
export function getActionSchemaIds(dir: string): Set<number> {
  const metaPath = join(dir, "meta.db");
  const db = new Database(metaPath, { readonly: true });
  try {
    const ids = db.query("SELECT id FROM action_schemas").all() as Array<{ id: number }>;
    return new Set(ids.map((r) => r.id));
  } finally {
    db.close();
  }
}
