import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { crc32c } from "../../binary/crc32c";
import { RangeBinWriter } from "../../binary/range-bin-writer";
import {
  dimensionKey,
  getBinFileName,
  getConcreteLinesTableName,
  getDrillScenarioTableName,
  quoteIdentifier,
  type RangeDimension,
} from "../../db/naming";
import { discoverRangeDimensions, type OldRangeRow } from "../../importer/old-sqlite";
import { encodeConcreteLinePack, toHex } from "../../importer/encode-pack";
import { PreflopStoreError } from "../../query/errors";
import { filterDimensions } from "../../utils/dimension";
import { getIdxFileName } from "../catalog/naming";
import { initLightMetaDb } from "../catalog/schema";
import { RangeIdxWriter } from "../index/writer";
import { resolveBuildPlan } from "./plan";
import type { BuildRangeStrataBinaryStoreOptions, BuildManifest, BuildReport, DimensionBuildStats } from "./types";
import { cleanupPreviousOutput } from "./cleanup";

export type {
  BuildRangeStrataBinaryStoreOptions,
  BuildManifest,
  BuildManifestDimension,
  BuildManifestDimensionStatus,
  BuildReport,
  DimensionBuildStats,
} from "./types";

interface BuildStatements {
  insertDrillLineByStrategy: Map<string, ReturnType<Database["prepare"]>>;
  insertConcreteLineByDimension: Map<string, ReturnType<Database["prepare"]>>;
  selectActionSchema: ReturnType<Database["prepare"]>;
  insertActionSchema: ReturnType<Database["prepare"]>;
  lastInsertId: ReturnType<Database["prepare"]>;
}

export async function buildRangeStrataBinaryStore(options: BuildRangeStrataBinaryStoreOptions): Promise<BuildReport> {
  const buildStart = performance.now();
  const rangeStrataStoreDir = options.outDir;
  await mkdir(rangeStrataStoreDir, { recursive: true });

  const metaDbPath = join(rangeStrataStoreDir, "meta.db");
  const buildManifestPath = join(rangeStrataStoreDir, "manifest.json");
  const previousBuildManifest = await readBuildManifest(buildManifestPath);

  // Calculate source DB size
  let sourceDbSizeBytes = 0;
  try {
    const s = await stat(options.sourceDbPath);
    sourceDbSizeBytes = s.size;
  } catch { /* ignore */ }

  // Compute source DB checksum
  const sourceRangeDbChecksum = await computeFileSha256(options.sourceDbPath);

  const sourceDb = new Database(options.sourceDbPath, { readonly: true });
  const targetRangeDimensions = filterDimensions(discoverRangeDimensions(sourceDb), options.dimensions);
  const targetStrategies = uniqueStrategies(targetRangeDimensions);
  const rangeStrataBuildPlan = await resolveBuildPlan({
    options: {
      rangeStrataStoreDir,
      overwrite: options.overwrite,
      resume: options.resume,
    },
    metaDbPath,
    previousManifest: previousBuildManifest,
    sourceRangeDbChecksum,
    targetRangeDimensions,
  });

  if (rangeStrataBuildPlan.shouldResetStoreArtifacts) {
    await cleanupPreviousOutput({
      rangeStrataStoreDir,
      metaDbPath,
      buildManifestPath,
      previousBuildManifest,
      targetRangeDimensions,
    });
  }
  const { reusableCompletedDimensionStats, pendingRangeDimensions } = rangeStrataBuildPlan;
  const shouldInitializeMetaDb = rangeStrataBuildPlan.mode !== "resume";

  const metaDb = new Database(metaDbPath);
  let statements: BuildStatements | null = null;

  try {
    // Only init meta.db for fresh builds
    if (shouldInitializeMetaDb) {
      initLightMetaDb(metaDb, targetRangeDimensions);
    }

    statements = prepareBuildStatements(metaDb, targetRangeDimensions);
    const schemaIdByKey = new Map<string, number>();

    // Copy metadata only on fresh build
    if (shouldInitializeMetaDb) {
      metaDb.exec("BEGIN");
      try {
        copyDrillScenarioLines({ sourceDb, statements, strategies: targetStrategies });
        for (const dimension of targetRangeDimensions) {
          copyConcreteLines({ sourceDb, statements, dimension });
        }
        metaDb.exec("COMMIT");
      } catch (error) {
        metaDb.exec("ROLLBACK");
        throw error;
      }
    }

    // Build dimensions
    const dimensionBuildResults: DimensionBuildStats[] = [...reusableCompletedDimensionStats];

    for (const dimension of pendingRangeDimensions) {
      dimensionBuildResults.push(
        await buildDimensionWithStats({
          sourceDb,
          metaDb,
          statements,
          schemaIdByKey,
          dimension,
          rangeStrataStoreDir,
          overwrite: options.overwrite,
          maxConcreteLines: options.maxConcreteLinesPerDimension,
          progressEveryPacks: options.progressEveryPacks ?? 10000,
        }),
      );
    }

    return await writeManifestAndReport({
      options,
      metaDb,
      metaDbPath,
      buildManifestPath,
      sourceRangeDbChecksum,
      sourceDbSizeBytes,
      targetRangeDimensions,
      dimensionBuildResults,
      buildStart,
    });
  } finally {
    finalizeBuildStatements(statements);
    metaDb.close();
    sourceDb.close();
  }
}

function uniqueStrategies(dimensions: RangeDimension[]): string[] {
  return [...new Set(dimensions.map((dimension) => dimension.strategy))];
}

async function readBuildManifest(buildManifestPath: string): Promise<BuildManifest | null> {
  if (!existsSync(buildManifestPath)) return null;

  try {
    return JSON.parse(await Bun.file(buildManifestPath).text()) as BuildManifest;
  } catch {
    return null;
  }
}

interface DimensionBuildResult {
  packCount: number;
  concreteLineCount: number;
  srcRowCount: number;
}

async function buildDimensionWithStats(params: {
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
    } catch { /* ignore */ }
    try {
      const idxStat = await stat(join(params.rangeStrataStoreDir, getIdxFileName(dimension.strategy, dimension.playerCount, dimension.depthBb)));
      dimStat.idxFileSizeBytes = idxStat.size;
    } catch { /* ignore */ }

    dimStat.packCount = result.packCount;
    dimStat.concreteLineCount = result.concreteLineCount;
    dimStat.srcRowCount = result.srcRowCount;
  } catch (error) {
    dimStat.error = error instanceof Error ? error.message : String(error);
  }

  dimStat.durationMs = performance.now() - dimStart;
  return dimStat;
}

async function writeManifestAndReport(params: {
  options: BuildRangeStrataBinaryStoreOptions;
  metaDb: Database;
  metaDbPath: string;
  buildManifestPath: string;
  sourceRangeDbChecksum: string;
  sourceDbSizeBytes: number;
  targetRangeDimensions: RangeDimension[];
  dimensionBuildResults: DimensionBuildStats[];
  buildStart: number;
}): Promise<BuildReport> {
  const {
    options,
    metaDb,
    metaDbPath,
    buildManifestPath,
    sourceRangeDbChecksum,
    sourceDbSizeBytes,
    targetRangeDimensions,
    dimensionBuildResults,
    buildStart,
  } = params;

  const manifest: BuildManifest = {
    format: "PFSP",
    version: 1,
    sourceDbChecksum: sourceRangeDbChecksum,
    builtAt: new Date().toISOString(),
    dimensions: dimensionBuildResults.map((s) => ({
      strategy: s.strategy,
      playerCount: s.playerCount,
      depthBb: s.depthBb,
      concreteLineCount: s.concreteLineCount,
      packCount: s.packCount,
      status: s.error ? "failed" : "success",
      error: s.error,
      binFile: getBinFileName(s.strategy, s.playerCount, s.depthBb),
      idxFile: getIdxFileName(s.strategy, s.playerCount, s.depthBb),
      binFileSizeBytes: s.binFileSizeBytes,
      idxFileSizeBytes: s.idxFileSizeBytes,
    })),
    files: ["meta.db"],
  };

  for (const dim of targetRangeDimensions) {
    manifest.files.push(getBinFileName(dim.strategy, dim.playerCount, dim.depthBb));
    manifest.files.push(getIdxFileName(dim.strategy, dim.playerCount, dim.depthBb));
  }

  await Bun.write(buildManifestPath, JSON.stringify(manifest, null, 2) + "\n");

  metaDb
    .prepare("INSERT OR REPLACE INTO build_info(key, value) VALUES (?, ?)")
    .run("built_at", manifest.builtAt);
  metaDb
    .prepare("INSERT OR REPLACE INTO build_info(key, value) VALUES (?, ?)")
    .run("source_checksum", sourceRangeDbChecksum);
  metaDb.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");

  let outputTotalSizeBytes = 0;
  let outputMetaDbSizeBytes = 0;
  try {
    const ms = await stat(metaDbPath);
    outputMetaDbSizeBytes = ms.size;
    outputTotalSizeBytes += ms.size;
  } catch { /* ignore */ }
  for (const s of dimensionBuildResults) {
    outputTotalSizeBytes += s.binFileSizeBytes + s.idxFileSizeBytes;
  }

  const totalDuration = performance.now() - buildStart;
  const report: BuildReport = {
    generatedAt: manifest.builtAt,
    sourceDbPath: options.sourceDbPath,
    sourceDbSizeBytes,
    outDir: options.outDir,
    outputTotalSizeBytes,
    outputMetaDbSizeBytes,
    compressionRatio: sourceDbSizeBytes > 0 ? outputTotalSizeBytes / sourceDbSizeBytes : 0,
    dimensions: dimensionBuildResults,
    totals: {
      dimensionCount: targetRangeDimensions.length,
      concreteLineCount: sum(dimensionBuildResults.map((s) => s.concreteLineCount)),
      packCount: sum(dimensionBuildResults.map((s) => s.packCount)),
      srcRowCount: sum(dimensionBuildResults.map((s) => s.srcRowCount)),
      totalDurationMs: totalDuration,
      errorCount: dimensionBuildResults.filter((s) => s.error).length,
    },
  };

  if (options.statsOutPath) {
    await mkdir(dirnameSafe(options.statsOutPath), { recursive: true });
    await Bun.write(options.statsOutPath, JSON.stringify(report, null, 2) + "\n");
  }

  if (options.statsMdPath) {
    await mkdir(dirnameSafe(options.statsMdPath), { recursive: true });
    await Bun.write(options.statsMdPath, renderBuildReportMarkdown(report));
  }

  console.log(
    `\nBuild complete: ${report.totals.dimensionCount} dimensions, ${formatNum(report.totals.packCount)} packs, ${formatNum(report.totals.concreteLineCount)} lines`,
  );
  console.log(
    `Source: ${formatBytes(report.sourceDbSizeBytes)}, Output: ${formatBytes(report.outputTotalSizeBytes)} (${(report.compressionRatio * 100).toFixed(1)}%)`,
  );
  console.log(`Duration: ${(report.totals.totalDurationMs / 1000).toFixed(1)}s`);
  if (report.totals.errorCount > 0) {
    console.log(`Errors: ${report.totals.errorCount}`);
  }

  return report;
}

function prepareBuildStatements(metaDb: Database, dimensions: RangeDimension[]): BuildStatements {
  const insertDrillLineByStrategy = new Map<string, ReturnType<Database["prepare"]>>();
  const insertConcreteLineByDimension = new Map<string, ReturnType<Database["prepare"]>>();

  const strategies = uniqueStrategies(dimensions);
  for (const strategy of strategies) {
    insertDrillLineByStrategy.set(
      strategy,
      metaDb.prepare(`
        INSERT OR IGNORE INTO ${quoteIdentifier(getDrillScenarioTableName(strategy))}(drill_name, abstract_line, player_count, drill_depth)
        VALUES (?, ?, ?, ?)
      `),
    );
  }

  for (const dimension of dimensions) {
    const { strategy, playerCount, depthBb } = dimension;
    insertConcreteLineByDimension.set(
      dimensionKey(dimension),
      metaDb.prepare(`
        INSERT OR IGNORE INTO ${quoteIdentifier(getConcreteLinesTableName(strategy, playerCount, depthBb))}(
          concrete_line_id, abstract_line, concrete_line
        )
        VALUES (?, ?, ?)
      `),
    );
  }

  return {
    insertDrillLineByStrategy,
    insertConcreteLineByDimension,
    selectActionSchema: metaDb.prepare("SELECT id FROM action_schemas WHERE schema_key = ?"),
    insertActionSchema: metaDb.prepare(`
      INSERT INTO action_schemas(action_count, action_blob, checksum, schema_key)
      VALUES (?, ?, ?, ?)
    `),
    lastInsertId: metaDb.prepare("SELECT last_insert_rowid() AS id"),
  };
}

function finalizeBuildStatements(statements: BuildStatements | null): void {
  if (!statements) return;

  for (const statement of statements.insertDrillLineByStrategy.values()) {
    safeFinalizeStatement(statement);
  }
  for (const statement of statements.insertConcreteLineByDimension.values()) {
    safeFinalizeStatement(statement);
  }
  safeFinalizeStatement(statements.selectActionSchema);
  safeFinalizeStatement(statements.insertActionSchema);
  safeFinalizeStatement(statements.lastInsertId);
}

function safeFinalizeStatement(statement: ReturnType<Database["prepare"]>): void {
  try {
    statement.finalize();
  } catch {
    // Ignore finalization races; Database.close() is still the final cleanup boundary.
  }
}

function copyDrillScenarioLines(params: {
  sourceDb: Database;
  statements: BuildStatements;
  strategies: string[];
}): void {
  for (const strategy of params.strategies) {
    const table = `drill_scenario_lines_${strategy}`;
    const exists = params.sourceDb
      .query("SELECT 1 AS ok FROM sqlite_master WHERE type = ? AND name = ?")
      .get("table", table);
    if (!exists) continue;

    const rows = params.sourceDb
      .query(`
        SELECT drill_name, abstract_line, player_count, depth
        FROM ${quoteIdentifier(table)}
        ORDER BY id
      `)
      .iterate() as IterableIterator<{
        drill_name: string;
        abstract_line: string;
        player_count: number;
        depth: number;
      }>;

    const statement = params.statements.insertDrillLineByStrategy.get(strategy);
    if (!statement) throw new PreflopStoreError("BUILD_ERROR", `Missing drill insert statement for strategy ${strategy}`, { strategy });

    for (const row of rows) {
      statement.run(row.drill_name, row.abstract_line, row.player_count, row.depth);
    }
  }
}

function copyConcreteLines(params: {
  sourceDb: Database;
  statements: BuildStatements;
  dimension: RangeDimension;
}): void {
  const key = dimensionKey(params.dimension);
  const statement = params.statements.insertConcreteLineByDimension.get(key);
  if (!statement) throw new PreflopStoreError("BUILD_ERROR", `Missing concrete insert statement for dimension ${key}`, { dimension: key });

  const rows = params.sourceDb
    .query(`
      SELECT id, abstract_line, concrete_line
      FROM ${quoteIdentifier(params.dimension.concreteTable)}
      ORDER BY id
    `)
    .iterate() as IterableIterator<{ id: number; abstract_line: string; concrete_line: string }>;

  for (const row of rows) {
    statement.run(row.id, row.abstract_line, row.concrete_line);
  }
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

  // Use temp files with atomic rename
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

  // Atomic rename temp files to final names
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

async function computeFileSha256(filePath: string): Promise<string> {
  try {
    const bytes = await Bun.file(filePath).bytes();
    return createHash("sha256").update(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)).digest("hex");
  } catch {
    return "unknown";
  }
}

function dirnameSafe(filePath: string): string {
  const lastSep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (lastSep === -1) return ".";
  return filePath.slice(0, lastSep);
}

function sum(values: number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

function formatNum(n: number): string {
  return n.toLocaleString("en-US");
}

function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + " GB";
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(2) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KB";
  return bytes + " B";
}

function renderBuildReportMarkdown(report: BuildReport): string {
  const rows = report.dimensions.map((s) => {
    const status = s.error ? `FAIL: ${s.error}` : "OK";
    return [
      `${s.strategy}_${s.playerCount}max_${s.depthBb}BB`,
      formatNum(s.packCount),
      formatNum(s.concreteLineCount),
      formatNum(s.srcRowCount),
      formatBytes(s.binFileSizeBytes),
      formatBytes(s.idxFileSizeBytes),
      s.durationMs > 0 ? `${(s.durationMs / 1000).toFixed(1)}s` : "-",
      status,
    ];
  });

  return `# Range Strata Binary Build Report

Generated: ${report.generatedAt}

## Summary

- Source: \`${report.sourceDbPath}\` (${formatBytes(report.sourceDbSizeBytes)})
- Output dir: \`${report.outDir}\`
- Total output: ${formatBytes(report.outputTotalSizeBytes)}
- meta.db: ${formatBytes(report.outputMetaDbSizeBytes)}
- Compression ratio: ${(report.compressionRatio * 100).toFixed(1)}%
- Dimensions: ${report.totals.dimensionCount}
- Packs: ${formatNum(report.totals.packCount)}
- Concrete lines: ${formatNum(report.totals.concreteLineCount)}
- Source rows: ${formatNum(report.totals.srcRowCount)}
- Duration: ${(report.totals.totalDurationMs / 1000).toFixed(1)}s
- Errors: ${report.totals.errorCount}

## Dimensions

| Dimension | Packs | Lines | Src Rows | .bin size | .idx size | Duration | Status |
|---|---|---|---|---|---|---|---|
${rows.map((r) => "| " + r.join(" | ") + " |").join("\n")}
`;
}
