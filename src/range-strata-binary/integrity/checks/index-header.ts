import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  IDX_MAGIC,
  IDX_HEADER_SIZE,
  IDX_RECORD_SIZE,
  decodeIdxHeader,
  decodeIdxRecordAt,
} from "../../index/types";
import type { BuildManifest, BuildManifestDimension } from "../../compiler/types";
import { dimensionKey } from "../../catalog/naming";
import type { VerifyCheckResult, VerifyFailure } from "../report";
import { HANDS_169 } from "../../../hand/hand-dict";

const MAX_HAND_COUNT = HANDS_169.length;

export function checkIndexHeader(dir: string, manifest: BuildManifest, validActionSchemaIds: Set<number>): VerifyCheckResult {
  const failures: VerifyFailure[] = [];

  for (const dim of manifest.dimensions) {
    if (dim.status === "failed") continue;
    if (!dim.idxFile) {
      failures.push({
        layer: "index-header",
        check: `dimension:${dimensionKey(dim)}`,
        reason: "MISSING_FILE",
        message: `manifest.dimensions entry for ${dimensionKey(dim)} has no idxFile`,
      });
      continue;
    }

    const idxPath = join(dir, dim.idxFile);
    let raw: Uint8Array;
    try {
      const fileStat = statSync(idxPath);
      if (fileStat.size < IDX_HEADER_SIZE) {
        failures.push({
          layer: "index-header",
          check: `dimension:${dimensionKey(dim)}`,
          reason: "TRUNCATED",
          message: `.idx file ${dim.idxFile} is too small (${fileStat.size} bytes, min ${IDX_HEADER_SIZE})`,
        });
        continue;
      }
      raw = new Uint8Array(readFileSync(idxPath).buffer);
    } catch {
      failures.push({
        layer: "index-header",
        check: `dimension:${dimensionKey(dim)}`,
        reason: "IO_ERROR",
        message: `Cannot read .idx file: ${idxPath}`,
      });
      continue;
    }

    const key = dimensionKey(dim);
    const dimFailures = validateIdxFile(raw, dim, key, validActionSchemaIds, idxPath, manifest);
    failures.push(...dimFailures);
  }

  return { failures };
}

function validateIdxFile(
  raw: Uint8Array,
  _dim: BuildManifestDimension,
  dimKey: string,
  validActionSchemaIds: Set<number>,
  filePath: string,
  _manifest: BuildManifest,
): VerifyFailure[] {
  const failures: VerifyFailure[] = [];

  // Parse header
  const headerBytes = raw.subarray(0, IDX_HEADER_SIZE);
  let header;
  try {
    header = decodeIdxHeader(headerBytes);
  } catch {
    failures.push({
      layer: "index-header",
      check: `dimension:${dimKey}`,
      reason: "INVALID_HEADER",
      message: `Failed to decode .idx header for ${filePath}`,
    });
    return failures;
  }

  // Magic
  if (header.magic !== IDX_MAGIC) {
    failures.push({
      layer: "index-header",
      check: `dimension:${dimKey}`,
      reason: "INVALID_MAGIC",
      message: `.idx magic expected "${IDX_MAGIC}", got "${header.magic}" in ${filePath}`,
    });
  }

  // Version
  if (header.version !== 1) {
    failures.push({
      layer: "index-header",
      check: `dimension:${dimKey}`,
      reason: "UNSUPPORTED_VERSION",
      message: `.idx version expected 1, got ${header.version} in ${filePath}`,
    });
  }

  // Header size
  if (header.headerSize !== IDX_HEADER_SIZE) {
    failures.push({
      layer: "index-header",
      check: `dimension:${dimKey}`,
      reason: "INVALID_HEADER_SIZE",
      message: `.idx headerSize expected ${IDX_HEADER_SIZE}, got ${header.headerSize} in ${filePath}`,
    });
  }

  // File size check
  const expectedMinSize = IDX_HEADER_SIZE + header.recordCount * IDX_RECORD_SIZE;
  if (raw.byteLength < expectedMinSize) {
    failures.push({
      layer: "index-header",
      check: `dimension:${dimKey}`,
      reason: "TRUNCATED",
      message: `.idx file size ${raw.byteLength} < expected minimum ${expectedMinSize} (header + ${header.recordCount} records)`,
    });
    return failures;
  }

  if (header.recordCount === 0) {
    return failures; // empty idx is valid
  }

  // Validate records
  let prevConcreteLineId = -1;
  const seenActionSchemaIds = new Set<number>();

  for (let i = 0; i < header.recordCount; i++) {
    const offset = IDX_HEADER_SIZE + i * IDX_RECORD_SIZE;
    const rec = decodeIdxRecordAt(raw.buffer, raw.byteOffset + offset);

    // Strictly increasing concreteLineId
    if (rec.concreteLineId <= prevConcreteLineId) {
      failures.push({
        layer: "index-header",
        check: `dimension:${dimKey}`,
        reason: "OUT_OF_ORDER",
        message: `.idx record ${i}: concreteLineId=${rec.concreteLineId} is not strictly greater than previous ${prevConcreteLineId}`,
      });
    }
    prevConcreteLineId = rec.concreteLineId;

    // handCount bounds
    if (rec.handCount < 0 || rec.handCount > MAX_HAND_COUNT) {
      failures.push({
        layer: "index-header",
        check: `dimension:${dimKey}`,
        reason: "INVALID_HAND_COUNT",
        message: `.idx record concreteLineId=${rec.concreteLineId}: handCount=${rec.handCount} out of range [0, ${MAX_HAND_COUNT}]`,
      });
    }

    // actionSchemaId exists in meta.db
    if (!validActionSchemaIds.has(rec.actionSchemaId)) {
      failures.push({
        layer: "index-header",
        check: `dimension:${dimKey}`,
        reason: "DANGLING_FOREIGN_KEY",
        message: `.idx record concreteLineId=${rec.concreteLineId}: actionSchemaId=${rec.actionSchemaId} not found in meta.db.action_schemas`,
      });
    }
    seenActionSchemaIds.add(rec.actionSchemaId);

    // Don't check offset/byteLength against .bin here — done in index-pack-cross
  }

  return failures;
}

/**
 * Collect idxRecordCount per dimension for the main report.
 */
export interface IndexDimensionInfo {
  strategy: string;
  playerCount: number;
  depthBb: number;
  recordCount: number;
}

export function collectIndexInfo(dir: string, manifest: BuildManifest): IndexDimensionInfo[] {
  const result: IndexDimensionInfo[] = [];

  for (const dim of manifest.dimensions) {
    if (dim.status === "failed" || !dim.idxFile) {
      result.push({
        strategy: dim.strategy,
        playerCount: dim.playerCount,
        depthBb: dim.depthBb,
        recordCount: 0,
      });
      continue;
    }

    const idxPath = join(dir, dim.idxFile);
    try {
      const fileStat = statSync(idxPath);
      if (fileStat.size >= IDX_HEADER_SIZE) {
        const headerBytes = new Uint8Array(readFileSync(idxPath).buffer, 0, IDX_HEADER_SIZE);
        const header = decodeIdxHeader(headerBytes);
        result.push({
          strategy: dim.strategy,
          playerCount: dim.playerCount,
          depthBb: dim.depthBb,
          recordCount: header.recordCount,
        });
      } else {
        result.push({
          strategy: dim.strategy,
          playerCount: dim.playerCount,
          depthBb: dim.depthBb,
          recordCount: 0,
        });
      }
    } catch {
      result.push({
        strategy: dim.strategy,
        playerCount: dim.playerCount,
        depthBb: dim.depthBb,
        recordCount: 0,
      });
    }
  }

  return result;
}
