import { Database } from "bun:sqlite";
import { rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { crc32c } from "../../binary/crc32c";
import { RangeBinWriter } from "../../binary/range-bin-writer";
import { dimensionKey, quoteIdentifier, type RangeDimension } from "../../db/naming";
import { encodeConcreteLinePack, toHex } from "../../importer/encode-pack";
import type { OldRangeRow } from "../../importer/old-sqlite";
import { getIdxFileName } from "../catalog/naming";
import { RangeIdxWriter } from "../index/writer";
import type { BuildStatements } from "./build-statements";
import type { DimensionBuildStats } from "./types";

interface DimensionBuildResult {
  packCount: number;
  concreteLineCount: number;
  srcRowCount: number;
}

export async function buildDimensionWithStats(params: {
  sourceDb: Database;
  metaDb: Database;
  statements: BuildStatements;
  schemaIdByKey: Map<string, number>;
  dimension: RangeDimension;
  rangeStrataStoreDir: string;
  overwrite?: boolean;
  maxConcreteLines?: number;
  progressEveryPacks: number;
}): Promise<DimensionBuildStats> {
  const dimStart = performance.now();
  const { dimension } = params;
  const dimStat: DimensionBuildStats = {
    strategy: dimension.strategy,
    playerCount: dimension.playerCount,
    depthBb: dimension.depthBb,
    concreteLineCount: 0,
    packCount: 0,
    binFileSizeBytes: 0,
    idxFileSizeBytes: 0,
    srcRowCount: 0,
    durationMs: 0,
    error: null,
  };

  try {
    const result = await buildDimension(params);

    try {
      const binStat = await stat(join(params.rangeStrataStoreDir, dimension.binFile));
      dimStat.binFileSizeBytes = binStat.size;
    } catch (error) {
      warnRecoverable(`Could not stat built .bin file for ${dimensionKey(dimension)}`, error);
    }
    try {
      const idxStat = await stat(join(params.rangeStrataStoreDir, getIdxFileName(dimension.strategy, dimension.playerCount, dimension.depthBb)));
      dimStat.idxFileSizeBytes = idxStat.size;
    } catch (error) {
      warnRecoverable(`Could not stat built .idx file for ${dimensionKey(dimension)}`, error);
    }

    dimStat.packCount = result.packCount;
    dimStat.concreteLineCount = result.concreteLineCount;
    dimStat.srcRowCount = result.srcRowCount;
  } catch (error) {
    dimStat.error = error instanceof Error ? error.message : String(error);
  }

  dimStat.durationMs = performance.now() - dimStart;
  return dimStat;
}

async function buildDimension(params: {
  sourceDb: Database;
  metaDb: Database;
  statements: BuildStatements;
  schemaIdByKey: Map<string, number>;
  dimension: RangeDimension;
  rangeStrataStoreDir: string;
  overwrite?: boolean;
  maxConcreteLines?: number;
  progressEveryPacks: number;
}): Promise<DimensionBuildResult> {
  const binBase = join(params.rangeStrataStoreDir, params.dimension.binFile);
  const idxBase = join(
    params.rangeStrataStoreDir,
    getIdxFileName(params.dimension.strategy, params.dimension.playerCount, params.dimension.depthBb),
  );

  const binTmp = binBase + ".tmp";
  const idxTmp = idxBase + ".tmp";

  const writer = await RangeBinWriter.create(binTmp, { overwrite: true });
  const idxWriter = await RangeIdxWriter.create(idxTmp, { overwrite: true });
  let currentConcreteLineId: number | null = null;
  let rowsForConcreteLine: OldRangeRow[] = [];
  let processedPacks = 0;
  let srcRowCount = 0;
  let committed = false;
  const seenConcreteLineIds = new Set<number>();
  const dimensionActionSchemaIds = new Set<number>();

  const flushCurrent = async (): Promise<boolean> => {
    if (currentConcreteLineId === null) return true;

    const concreteLineId = currentConcreteLineId;
    const encoded = encodeConcreteLinePack(rowsForConcreteLine);
    const actionSchemaId = getOrInsertActionSchema({
      statements: params.statements,
      schemaIdByKey: params.schemaIdByKey,
      actionBlob: encoded.actionBlob,
      actionCount: encoded.actionCount,
    });
    dimensionActionSchemaIds.add(actionSchemaId);
    const appended = await writer.append(encoded.payload);

    await idxWriter.append({
      concreteLineId,
      actionSchemaId,
      handCount: encoded.handCount,
      offset: appended.offset,
      byteLength: appended.byteLength,
      checksum: appended.checksum,
    });

    processedPacks += 1;
    if (processedPacks % params.progressEveryPacks === 0) {
      console.log(
        `[${params.dimension.strategy} ${params.dimension.playerCount}max ${params.dimension.depthBb}BB] packs=${processedPacks}`,
      );
    }

    currentConcreteLineId = null;
    rowsForConcreteLine = [];

    return !params.maxConcreteLines || processedPacks < params.maxConcreteLines;
  };

  params.metaDb.exec("BEGIN");
  try {
    const rangeRows = params.sourceDb
      .query(`
        SELECT concrete_line_id, hole_cards, action_name, action_size, amount_bb, frequency, hand_ev
        FROM ${quoteIdentifier(params.dimension.rangeTable)}
        ORDER BY concrete_line_id, hole_cards, action_name
      `)
      .iterate() as IterableIterator<OldRangeRow>;

    for (const row of rangeRows) {
      srcRowCount++;

      if (currentConcreteLineId === null) {
        currentConcreteLineId = row.concrete_line_id;
      }

      if (row.concrete_line_id !== currentConcreteLineId) {
        seenConcreteLineIds.add(currentConcreteLineId);
        const shouldContinue = await flushCurrent();
        if (!shouldContinue) break;

        currentConcreteLineId = row.concrete_line_id;
        rowsForConcreteLine = [];
      }

      rowsForConcreteLine.push(row);
    }

    if (currentConcreteLineId !== null) {
      seenConcreteLineIds.add(currentConcreteLineId);
    }
    await flushCurrent();
    params.metaDb.exec("COMMIT");
    const insertStmt = params.metaDb.prepare(`
      INSERT OR IGNORE INTO dimension_action_schemas(strategy, player_count, depth_bb, action_schema_id)
      VALUES (?, ?, ?, ?)
    `);
    for (const schemaId of dimensionActionSchemaIds) {
      insertStmt.run(params.dimension.strategy, params.dimension.playerCount, params.dimension.depthBb, schemaId);
    }
    insertStmt.finalize();
    committed = true;
  } catch (error) {
    params.metaDb.exec("ROLLBACK");
    throw error;
  } finally {
    await writer.close();
    await idxWriter.close();
    if (!committed) {
      await rm(binTmp, { force: true });
      await rm(idxTmp, { force: true });
    }
  }

  await rename(binTmp, binBase);
  await rename(idxTmp, idxBase);

  return {
    packCount: processedPacks,
    concreteLineCount: seenConcreteLineIds.size,
    srcRowCount,
  };
}

function getOrInsertActionSchema(params: {
  statements: BuildStatements;
  schemaIdByKey: Map<string, number>;
  actionBlob: Uint8Array;
  actionCount: number;
}): number {
  const schemaKey = toHex(params.actionBlob);
  const cachedId = params.schemaIdByKey.get(schemaKey);
  if (cachedId !== undefined) return cachedId;

  const existing = params.statements.selectActionSchema.get(schemaKey) as { id: number } | null;
  if (existing) {
    params.schemaIdByKey.set(schemaKey, existing.id);
    return existing.id;
  }

  params.statements.insertActionSchema.run(
    params.actionCount,
    Buffer.from(params.actionBlob.buffer, params.actionBlob.byteOffset, params.actionBlob.byteLength),
    crc32c(params.actionBlob),
    schemaKey,
  );
  const inserted = params.statements.lastInsertId.get() as { id: number };
  params.schemaIdByKey.set(schemaKey, inserted.id);
  return inserted.id;
}

function warnRecoverable(message: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.warn(`[build] ${message}: ${detail}`);
}
