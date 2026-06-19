import { Database } from "bun:sqlite";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { crc32c } from "../../../binary/crc32c";
import { decodeActionSchema, normalizeActionName, type ActionDef } from "../../../binary/action-schema-codec";
import { getHandId } from "../../../hand/hand-dict";
import { decodeRangePack, type DecodedRangePack } from "../../../binary/range-pack-codec";
import { RangeBinFileReader } from "../../../binary/range-bin-file-reader";
import {
  dimensionKey,
  getBinFileName,
  quoteIdentifier,
} from "../../../db/naming";
import { discoverRangeDimensions, type OldRangeRow } from "../../../importer/old-sqlite";
import {
  checkFloat32RoundTrip,
  checkNullableFloat32RoundTrip,
  Float32PrecisionStatsAccumulator,
  formatFloat32Bits,
  type Float32PrecisionStats,
} from "../../../precision/float32";
import type { BuildManifest } from "../../importer/build-binary-store";
import {
  IDX_HEADER_SIZE,
  IDX_RECORD_SIZE,
  decodeIdxHeader,
  decodeIdxRecordAt,
} from "../../idx/idx-types";
import type { VerifyFailure } from "../report";

const ACTION_VALUE_TOLERANCE = 1e-6;

export interface SourceCrossOptions {
  sourceDbPath: string;
  dir: string;
  manifest: BuildManifest;
  sampleSize: number;
  maxFailures: number;
}

export interface SourceCrossResult {
  failures: VerifyFailure[];
  checkedRecords: number;
  failedRecords: number;
  extraBinaryRecords: number;
  maxFrequencyError: number;
  maxHandEvError: number;
  precision: {
    frequency: Float32PrecisionStats;
    handEv: Float32PrecisionStats;
  };
}

export function runSourceCross(options: SourceCrossOptions): SourceCrossResult {
  const failures: VerifyFailure[] = [];
  const sourceDb = new Database(options.sourceDbPath, { readonly: true });
  const dimensions = discoverRangeDimensions(sourceDb);
  const metaDbPath = join(options.dir, "meta.db");
  const metaDb = new Database(metaDbPath, { readonly: true });

  let checkedRecords = 0;
  let failedRecords = 0;
  let extraBinaryRecords = 0;
  let maxFrequencyError = 0;
  let maxHandEvError = 0;
  const frequencyPrecision = new Float32PrecisionStatsAccumulator();
  const handEvPrecision = new Float32PrecisionStatsAccumulator();

  // Cache action schemas from meta.db
  const actionSchemaCache = new Map<number, ActionDef[]>();
  // Cache per-dimension idx data
  const idxDataCache = new Map<string, { raw: Uint8Array; recordCount: number }>();

  try {
    for (const dim of dimensions) {
      const key = dimensionKey(dim);
      const manifestDim = options.manifest.dimensions.find(
        (d) => d.strategy === dim.strategy && d.playerCount === dim.playerCount && d.depthBb === dim.depthBb,
      );
      if (manifestDim?.status === "failed") continue;

      // Load idx data
      const idxFileName = `ranges_${dim.strategy}_${dim.playerCount}max_${dim.depthBb}BB.idx`;
      const idxPath = join(options.dir, idxFileName);
      let idxRaw: Uint8Array;
      let idxRecordCount: number;
      if (idxDataCache.has(idxFileName)) {
        const cached = idxDataCache.get(idxFileName)!;
        idxRaw = cached.raw;
        idxRecordCount = cached.recordCount;
      } else {
        try {
          idxRaw = new Uint8Array(readFileSync(idxPath).buffer);
          const header = decodeIdxHeader(idxRaw.subarray(0, IDX_HEADER_SIZE));
          idxRecordCount = header.recordCount;
          idxDataCache.set(idxFileName, { raw: idxRaw, recordCount: idxRecordCount });
        } catch {
          failures.push({
            layer: "source-cross",
            check: key,
            reason: "IO_ERROR",
            message: `Cannot read .idx file for dimension ${key}`,
          });
          continue;
        }
      }

      // Open bin file reader
      const binFileName = getBinFileName(dim.strategy, dim.playerCount, dim.depthBb);
      const binPath = join(options.dir, binFileName);
      let binReader: RangeBinFileReader;
      try {
        binReader = new RangeBinFileReader(binPath);
        binReader.open();
      } catch (e) {
        failures.push({
          layer: "source-cross",
          check: key,
          reason: "IO_ERROR",
          message: `Cannot open .bin file for ${key}: ${e instanceof Error ? e.message : String(e)}`,
        });
        continue;
      }

      // Build concreteLineId -> idxOffset map
      const idxMap = new Map<number, number>(); // concreteLineId -> recordIndex
      for (let i = 0; i < idxRecordCount; i++) {
        const recordOffset = IDX_HEADER_SIZE + i * IDX_RECORD_SIZE;
        const clId = new DataView(idxRaw.buffer, idxRaw.byteOffset + recordOffset, 4).getUint32(0, true);
        idxMap.set(clId, recordOffset);
      }

      // Query source DB rows
      let rows: OldRangeRow[];
      if (options.sampleSize > 0) {
        // Sampling mode: allocate proportionally
        const totalCount = sourceDb
          .query(`SELECT COUNT(*) as c FROM ${quoteIdentifier(dim.rangeTable)}`)
          .get() as { c: number };
        const allRowCounts = dimensions.map((d) => {
          const r = sourceDb.query(`SELECT COUNT(*) as c FROM ${quoteIdentifier(d.rangeTable)}`).get() as { c: number };
          return r.c;
        });
        const totalRows = allRowCounts.reduce((a, b) => a + b, 0);
        const quota = Math.max(1, Math.floor((totalCount.c / totalRows) * options.sampleSize));
        rows = sourceDb
          .query(
            `SELECT concrete_line_id, hole_cards, action_name, action_size, amount_bb, frequency, hand_ev
             FROM ${quoteIdentifier(dim.rangeTable)}
             ORDER BY random() LIMIT ?`,
          )
          .all(Math.min(quota, totalCount.c)) as OldRangeRow[];
      } else {
        rows = sourceDb
          .query(
            `SELECT concrete_line_id, hole_cards, action_name, action_size, amount_bb, frequency, hand_ev
             FROM ${quoteIdentifier(dim.rangeTable)}
             ORDER BY concrete_line_id, hole_cards, action_name`,
          )
          .all() as OldRangeRow[];
      }

      // Group by concrete_line_id
      const byCL = new Map<number, OldRangeRow[]>();
      for (const row of rows) {
        const list = byCL.get(row.concrete_line_id);
        if (list) list.push(row);
        else byCL.set(row.concrete_line_id, [row]);
      }

      // Verify each concrete line group
      for (const [concreteLineId, oldRows] of byCL) {
        const recordByteOffset = idxMap.get(concreteLineId);
        if (recordByteOffset === undefined) {
          for (const row of oldRows) {
            checkedRecords++;
            failedRecords++;
            if (failures.length < options.maxFailures) {
              failures.push({
                layer: "source-cross",
                check: key,
                reason: "PACK_NOT_FOUND_IN_IDX",
                message: `concreteLineId=${concreteLineId} found in source DB but not in .idx`,
                context: `line=${concreteLineId} hole=${row.hole_cards}`,
              });
            }
          }
          continue;
        }

        const rec = decodeIdxRecordAt(idxRaw.buffer, idxRaw.byteOffset + recordByteOffset);

        // Load action schema
        let actions = actionSchemaCache.get(rec.actionSchemaId);
        if (!actions) {
          const schemaRow = metaDb
            .query("SELECT action_count, action_blob FROM action_schemas WHERE id = ?")
            .get(rec.actionSchemaId) as { action_count: number; action_blob: Uint8Array } | null;
          if (!schemaRow) {
            checkedRecords += oldRows.length;
            failedRecords += oldRows.length;
            continue;
          }
          const blob = new Uint8Array(schemaRow.action_blob.buffer, schemaRow.action_blob.byteOffset, schemaRow.action_blob.byteLength);
          actions = decodeActionSchema(blob, schemaRow.action_count);
          actionSchemaCache.set(rec.actionSchemaId, actions);
        }

        // Read pack data
        let packData: Uint8Array;
        try {
          packData = binReader.read(rec.offset, rec.byteLength);
        } catch {
          checkedRecords += oldRows.length;
          failedRecords += oldRows.length;
          continue;
        }

        // CRC check
        const actualCrc = crc32c(packData);
        if (actualCrc !== (rec.checksum >>> 0)) {
          checkedRecords += oldRows.length;
          failedRecords += oldRows.length;
          if (failures.length < options.maxFailures) {
            failures.push({
              layer: "source-cross",
              check: key,
              reason: "CHECKSUM_MISMATCH",
              message: `concreteLineId=${concreteLineId}: CRC mismatch`,
              context: `expected=${rec.checksum >>> 0} actual=${actualCrc}`,
            });
          }
          continue;
        }

        // Decode pack
        let decoded: DecodedRangePack;
        try {
          decoded = decodeRangePack({ bytes: packData, handCount: rec.handCount, actionCount: actions.length });
        } catch {
          checkedRecords += oldRows.length;
          failedRecords += oldRows.length;
          continue;
        }

        const handIndexById = new Map(decoded.handIds.map((handId, handIndex) => [handId, handIndex]));
        const expectedBinaryCells = new Set<string>();

        for (const row of oldRows) {
          checkedRecords++;

          let handId: number;
          try {
            handId = getHandId(row.hole_cards);
          } catch {
            failedRecords++;
            if (failures.length < options.maxFailures) {
              failures.push({
                layer: "source-cross",
                check: key,
                reason: "UNKNOWN_HAND",
                message: `Unknown hand: ${row.hole_cards}`,
                context: `line=${concreteLineId}`,
              });
            }
            continue;
          }

          const localHandIndex = handIndexById.get(handId);
          if (localHandIndex === undefined) {
            failedRecords++;
            if (failures.length < options.maxFailures) {
              failures.push({
                layer: "source-cross",
                check: key,
                reason: "HAND_NOT_FOUND_IN_PACK",
                message: `Hand ${row.hole_cards} in source but not in pack`,
                context: `line=${concreteLineId}`,
              });
            }
            continue;
          }

          const action = findMatchingAction(actions, row);
          if (!action) {
            failedRecords++;
            if (failures.length < options.maxFailures) {
              failures.push({
                layer: "source-cross",
                check: key,
                reason: "ACTION_NOT_FOUND_IN_SCHEMA",
                message: `Action ${row.action_name}/${row.action_size}/${row.amount_bb} not in schema`,
                context: `line=${concreteLineId}`,
              });
            }
            continue;
          }

          const cell = decoded.cells[localHandIndex * actions.length + action.actionId];
          const binaryCellKey = `${handId}\0${action.actionId}`;

          if (!cell.exists) {
            failedRecords++;
            if (failures.length < options.maxFailures) {
              failures.push({
                layer: "source-cross",
                check: key,
                reason: "ACTION_CELL_NOT_SET",
                message: `Cell not set for ${row.hole_cards}/${row.action_name}`,
                context: `line=${concreteLineId}`,
              });
            }
            continue;
          }

          expectedBinaryCells.add(binaryCellKey);
          const frequencyError = Math.abs(Number(row.frequency) - cell.frequency);
          const handEvError = getNullableNumberError(row.hand_ev, cell.handEV);
          maxFrequencyError = Math.max(maxFrequencyError, frequencyError);
          maxHandEvError = Math.max(maxHandEvError, handEvError);

          let reason: string | null = null;
          let details = "";
          const context = `line=${concreteLineId} hole=${row.hole_cards} action=${row.action_name}`;
          const frequencyCheck = checkFloat32RoundTrip(Number(row.frequency), cell.frequency);
          frequencyPrecision.add(frequencyCheck, context);

          if (!frequencyCheck.ok) {
            reason = frequencyCheck.reason === "FLOAT32_VALUE_MISMATCH"
              ? "FREQUENCY_FLOAT32_MISMATCH"
              : "FREQUENCY_INVALID_NUMBER";
            details = [
              `source=${row.frequency}`,
              `expectedFloat32=${frequencyCheck.expectedValue}`,
              `actual=${cell.frequency}`,
              `expectedBits=${formatFloat32Bits(frequencyCheck.expectedBits)}`,
              `actualBits=${formatFloat32Bits(frequencyCheck.actualBits)}`,
              `quantizationDiff=${frequencyCheck.quantizationAbsError}`,
              `implementationDiff=${frequencyCheck.implementationAbsError}`,
            ].join(", ");
          }

          const handEvCheck = checkNullableFloat32RoundTrip(row.hand_ev, cell.handEV);
          if (handEvCheck.value) {
            handEvPrecision.add(handEvCheck.value, context);
          } else if (handEvCheck.reason === "NULL_MATCH") {
            handEvPrecision.addNull();
          }

          if (!reason && !handEvCheck.ok) {
            reason = handEvCheck.reason === "NULL_MISMATCH"
              ? "HAND_EV_NULL_MISMATCH"
              : handEvCheck.reason === "FLOAT32_VALUE_MISMATCH"
                ? "HAND_EV_FLOAT32_MISMATCH"
                : "HAND_EV_INVALID_NUMBER";
            details = handEvCheck.value
              ? [
                  `source=${row.hand_ev}`,
                  `expectedFloat32=${handEvCheck.value.expectedValue}`,
                  `actual=${cell.handEV}`,
                  `expectedBits=${formatFloat32Bits(handEvCheck.value.expectedBits)}`,
                  `actualBits=${formatFloat32Bits(handEvCheck.value.actualBits)}`,
                  `quantizationDiff=${handEvCheck.value.quantizationAbsError}`,
                  `implementationDiff=${handEvCheck.value.implementationAbsError}`,
                ].join(", ")
              : `source=${row.hand_ev}, actual=${cell.handEV}`;
          }

          if (reason) {
            failedRecords++;
            if (failures.length < options.maxFailures) {
              failures.push({
                layer: "source-cross",
                check: key,
                reason,
                message: details,
                context,
              });
            }
          }
        }

        // Check extra binary records (only in full mode)
        if (options.sampleSize === 0) {
          for (const cell of decoded.cells) {
            if (!cell.exists) continue;
            const key = `${cell.handId}\0${cell.actionId}`;
            if (!expectedBinaryCells.has(key)) extraBinaryRecords++;
          }
        }
      }

      binReader.close();
    }
  } finally {
    metaDb.close();
    sourceDb.close();
  }

  return {
    failures,
    checkedRecords,
    failedRecords,
    extraBinaryRecords,
    maxFrequencyError,
    maxHandEvError,
    precision: {
      frequency: frequencyPrecision.toJSON(),
      handEv: handEvPrecision.toJSON(),
    },
  };
}

function findMatchingAction(actions: ActionDef[], row: OldRangeRow): ActionDef | null {
  const actionName = normalizeActionName(row.action_name);
  const actionSize = Number(row.action_size);
  const amountBB = Number(row.amount_bb);

  return (
    actions.find(
      (action) =>
        action.actionName === actionName &&
        Math.abs(action.actionSize - actionSize) <= ACTION_VALUE_TOLERANCE &&
        Math.abs(action.amountBB - amountBB) <= ACTION_VALUE_TOLERANCE,
    ) ?? null
  );
}

function getNullableNumberError(left: number | null, right: number | null): number {
  if (left === null && right === null) return 0;
  if (left === null || right === null) return Number.POSITIVE_INFINITY;
  return Math.abs(Number(left) - Number(right));
}
