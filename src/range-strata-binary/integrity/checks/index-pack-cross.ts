import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  IDX_HEADER_SIZE,
  IDX_RECORD_SIZE,
  decodeIdxHeader,
  decodeIdxRecordAt,
} from "../../index/types";
import { crc32c } from "../../../binary/crc32c";
import type { BuildManifest } from "../../compiler/types";
import { dimensionKey } from "../../catalog/naming";
import type { VerifyCheckResult, VerifyFailure } from "../report";

export interface IndexPackCrossOptions {
  verifyChecksums: boolean;
}

export function checkIndexPackCross(dir: string, manifest: BuildManifest, options: IndexPackCrossOptions): VerifyCheckResult {
  const failures: VerifyFailure[] = [];

  // Prepare action_schema cache from meta.db
  const metaPath = join(dir, "meta.db");
  let metaDb: Database | null = null;
  const actionSchemaCache = new Map<number, { actionCount: number; blob: Uint8Array }>();

  try {
    metaDb = new Database(metaPath, { readonly: true });
    const schemas = metaDb
      .query("SELECT id, action_count, action_blob FROM action_schemas")
      .all() as Array<{ id: number; action_count: number; action_blob: Buffer }>;
    for (const s of schemas) {
      actionSchemaCache.set(s.id, {
        actionCount: s.action_count,
        blob: new Uint8Array(s.action_blob.buffer, s.action_blob.byteOffset, s.action_blob.byteLength),
      });
    }
  } catch {
    failures.push({
      layer: "index-pack-cross",
      check: "catalog",
      reason: "IO_ERROR",
      message: "Cannot open meta.db for index-pack cross reference checks",
    });
    return { failures };
  } finally {
    metaDb?.close();
  }

  for (const dim of manifest.dimensions) {
    if (dim.status === "failed") continue;
    if (!dim.idxFile || !dim.binFile) continue;

    const idxPath = join(dir, dim.idxFile);
    const binPath = join(dir, dim.binFile);
    const key = dimensionKey(dim);

    let idxRaw: Uint8Array;
    let binRaw: Uint8Array;
    try {
      idxRaw = new Uint8Array(readFileSync(idxPath).buffer);
      // Read entire .bin file into memory once, then slice from it per-record
      binRaw = new Uint8Array(readFileSync(binPath).buffer);
    } catch {
      failures.push({
        layer: "index-pack-cross",
        check: `dimension:${key}`,
        reason: "IO_ERROR",
        message: `Cannot read ${idxPath} or ${binPath}`,
      });
      continue;
    }

    if (idxRaw.byteLength < IDX_HEADER_SIZE) continue; // already reported by index-header

    const header = decodeIdxHeader(idxRaw.subarray(0, IDX_HEADER_SIZE));
    const recordCount = header.recordCount;
    const binFileSize = binRaw.byteLength;

    for (let i = 0; i < recordCount; i++) {
      const recordOffset = IDX_HEADER_SIZE + i * IDX_RECORD_SIZE;
      const rec = decodeIdxRecordAt(idxRaw.buffer, idxRaw.byteOffset + recordOffset);

      // Check offset + byteLength within .bin bounds
      const packEnd = rec.offset + rec.byteLength;
      if (rec.offset < 16) {
        // Magic header occupies first 16 bytes
        failures.push({
          layer: "index-pack-cross",
          check: `dimension:${key}`,
          reason: "INVALID_OFFSET",
          message: `.idx record concreteLineId=${rec.concreteLineId}: offset=${rec.offset} is within .bin header (0..15)`,
        });
      }
      if (packEnd > binFileSize) {
        failures.push({
          layer: "index-pack-cross",
          check: `dimension:${key}`,
          reason: "OUT_OF_BOUNDS",
          message: `.idx record concreteLineId=${rec.concreteLineId}: offset+byteLength=${packEnd} exceeds .bin file size ${binFileSize}`,
        });
        continue; // skip further checks for this record
      }

      // Check pack byteLength formula
      const schemaInfo = actionSchemaCache.get(rec.actionSchemaId);
      if (schemaInfo) {
        const expectedPackLen = rec.handCount * (5 + schemaInfo.actionCount * 8);
        if (rec.byteLength !== expectedPackLen) {
          failures.push({
            layer: "index-pack-cross",
            check: `dimension:${key}`,
            reason: "PACK_SIZE_MISMATCH",
            message: `.idx record concreteLineId=${rec.concreteLineId}: byteLength=${rec.byteLength} != handCount*(${5}+${schemaInfo.actionCount}*8)=${expectedPackLen}`,
          });
        }
      }

      // Validate pack data from in-memory buffer
      if (options.verifyChecksums || failures.length < 5) {
        // Slice from in-memory buffer instead of re-reading from disk
        const packData = binRaw.subarray(rec.offset, rec.offset + rec.byteLength);

        // CRC32C check
        if (options.verifyChecksums) {
          const actualCrc = crc32c(packData);
          if (actualCrc !== (rec.checksum >>> 0)) {
            failures.push({
              layer: "index-pack-cross",
              check: `dimension:${key}`,
              reason: "CHECKSUM_MISMATCH",
              message: `.idx record concreteLineId=${rec.concreteLineId}: stored CRC ${rec.checksum >>> 0} != computed ${actualCrc}`,
            });
          }
        }

        // Validate handIds are ascending and in range
        if (rec.handCount > 0) {
          let prevHandId = -1;
          for (let h = 0; h < rec.handCount; h++) {
            const handId = packData[h];
            if (handId > 168) {
              failures.push({
                layer: "index-pack-cross",
                check: `dimension:${key}`,
                reason: "INVALID_HAND_ID",
                message: `.idx record concreteLineId=${rec.concreteLineId}: handId=${handId} at index ${h} is out of range [0, 168]`,
              });
            }
            if (handId <= prevHandId && h > 0) {
              failures.push({
                layer: "index-pack-cross",
                check: `dimension:${key}`,
                reason: "HAND_ID_NOT_SORTED",
                message: `.idx record concreteLineId=${rec.concreteLineId}: handIds not strictly increasing at index ${h} (${handId} <= ${prevHandId})`,
              });
              break;
            }
            prevHandId = handId;
          }
        }
      }
    }
  }

  return { failures };
}
