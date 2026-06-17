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
import { getIdxFileName } from "../db/naming";
import { initLightMetaDb } from "../db/schema";
import { RangeIdxWriter } from "../idx/idx-writer";

export interface BuildBinaryStoreSchema2Options {
  sourceDbPath: string;
  outDir: string;
  overwrite?: boolean;
  /** Skip dimensions already completed (based on manifest.json). */
  resume?: boolean;
  dimensions?: Array<Pick<RangeDimension, "strategy" | "playerCount" | "depthBb">>;
  maxConcreteLinesPerDimension?: number;
  progressEveryPacks?: number;
  /** Output build stats to JSON + Markdown. */
  statsOutPath?: string;
  statsMdPath?: string;
}

interface BuildStatements {
  insertDrillLineByStrategy: Map<string, ReturnType<Database["prepare"]>>;
  insertConcreteLineByDimension: Map<string, ReturnType<Database["prepare"]>>;
  selectActionSchema: ReturnType<Database["prepare"]>;
  insertActionSchema: ReturnType<Database["prepare"]>;
  lastInsertId: ReturnType<Database["prepare"]>;
}

export interface BuildManifest {
  format: "PFSP";
  version: 1;
  sourceDbChecksum: string;
  builtAt: string;
  dimensions: BuildManifestDimension[];
  files: string[];
}

export type BuildManifestDimensionStatus = "success" | "failed";

export interface BuildManifestDimension {
  strategy: string;
  playerCount: number;
  depthBb: number;
  concreteLineCount: number;
  packCount: number;
  status?: BuildManifestDimensionStatus;
  error?: string | null;
  binFile?: string;
  idxFile?: string;
  binFileSizeBytes?: number;
  idxFileSizeBytes?: number;
}

export interface DimensionBuildStats {
  strategy: string;
  playerCount: number;
  depthBb: number;
  concreteLineCount: number;
  packCount: number;
  binFileSizeBytes: number;
  idxFileSizeBytes: number;
  srcRowCount: number;
  durationMs: number;
  error: string | null;
}

export interface BuildReport {
  generatedAt: string;
  sourceDbPath: string;
  sourceDbSizeBytes: number;
  outDir: string;
  outputTotalSizeBytes: number;
  outputMetaDbSizeBytes: number;
  compressionRatio: number;
  dimensions: DimensionBuildStats[];
  totals: {
    dimensionCount: number;
    concreteLineCount: number;
    packCount: number;
    srcRowCount: number;
    totalDurationMs: number;
    errorCount: number;
  };
}

export async function buildBinaryStoreScheme2(options: BuildBinaryStoreSchema2Options): Promise<BuildReport> {
  const buildStart = performance.now();
  await mkdir(options.outDir, { recursive: true });

  const metaPath = join(options.outDir, "meta.db");
  const manifestPath = join(options.outDir, "manifest.json");
  let previousManifest = await readBuildManifest(manifestPath);

  // Reject if meta.db already exists and overwrite is not set
  if (existsSync(metaPath) && !options.overwrite) {
    if (options.resume && previousManifest) {
      // Resume mode — ok to continue with existing meta.db
    } else if (options.resume) {
      throw new PreflopStoreError("BUILD_ERROR", "meta.db exists but manifest.json is missing or unreadable. Pass --overwrite to rebuild from scratch.", { metaPath });
    } else {
      throw new PreflopStoreError("BUILD_ERROR", `Output meta DB already exists: ${metaPath}. Pass --overwrite to rebuild it or --resume to continue.`, { metaPath });
    }
  }

  const sourceDb = new Database(options.sourceDbPath, { readonly: true });
  const allDimensions = filterDimensions(discoverRangeDimensions(sourceDb), options.dimensions);
  const strategies = uniqueStrategies(allDimensions);

  // Calculate source DB size
  let sourceDbSizeBytes = 0;
  try {
    const s = await stat(options.sourceDbPath);
    sourceDbSizeBytes = s.size;
  } catch { /* ignore */ }

  // Compute source DB checksum
  const sourceDbChecksum = await computeFileSha256(options.sourceDbPath);

  // If overwrite is set, clean up previous output and ignore resume
  if (options.overwrite) {
    await cleanupPreviousOutput({ outDir: options.outDir, metaPath, manifestPath, manifest: previousManifest, dimensions: allDimensions });
    previousManifest = null;
  }

  const isFreshBuild = !existsSync(metaPath);
  const previousCompletedStats = options.resume && !isFreshBuild && previousManifest
    ? await collectCompletedManifestStats(previousManifest, options.outDir)
    : [];
  const completedDimKeys = new Set(previousCompletedStats.map((dimension) => manifestDimensionKey(dimension)));
  const dimensionsToBuild = options.resume && !isFreshBuild
    ? allDimensions.filter((dimension) => !completedDimKeys.has(manifestDimensionKey(dimension)))
    : allDimensions;

  const metaDb = new Database(metaPath);

  try {
    // Only init meta.db for fresh builds
    if (isFreshBuild) {
      initLightMetaDb(metaDb, allDimensions);
    }

    const statements = prepareBuildStatements(metaDb, allDimensions);
    const schemaIdByKey = new Map<string, number>();

    // Copy metadata only on fresh build
    if (isFreshBuild) {
      metaDb.exec("BEGIN");
      try {
        copyDrillScenarioLines({ sourceDb, statements, strategies });
        for (const dimension of allDimensions) {
          copyConcreteLines({ sourceDb, statements, dimension });
        }
        metaDb.exec("COMMIT");
      } catch (error) {
        metaDb.exec("ROLLBACK");
        throw error;
      }
    }

    // Build dimensions
    const dimensionStats: DimensionBuildStats[] = [...previousCompletedStats];

    for (const dimension of dimensionsToBuild) {
      const dimStart = performance.now();
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
        const result = await buildDimension({
          sourceDb,
          metaDb,
          statements,
          schemaIdByKey,
          dimension,
          outDir: options.outDir,
          overwrite: options.overwrite,
          maxConcreteLines: options.maxConcreteLinesPerDimension,
          progressEveryPacks: options.progressEveryPacks ?? 10000,
        });

        // Get file sizes
        try {
          const binStat = await stat(join(options.outDir, dimension.binFile));
          dimStat.binFileSizeBytes = binStat.size;
        } catch { /* ignore */ }
        try {
          const idxStat = await stat(join(options.outDir, getIdxFileName(dimension.strategy, dimension.playerCount, dimension.depthBb)));
          dimStat.idxFileSizeBytes = idxStat.size;
        } catch { /* ignore */ }

        dimStat.packCount = result.packCount;
        dimStat.concreteLineCount = result.concreteLineCount;
        dimStat.srcRowCount = result.srcRowCount;
      } catch (error) {
        dimStat.error = error instanceof Error ? error.message : String(error);
      }

      dimStat.durationMs = performance.now() - dimStart;
      dimensionStats.push(dimStat);
    }

    // Write manifest
    const manifest: BuildManifest = {
      format: "PFSP",
      version: 1,
      sourceDbChecksum,
      builtAt: new Date().toISOString(),
      dimensions: dimensionStats.map((s) => ({
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

    // Collect bin/idx files
    for (const dim of allDimensions) {
      manifest.files.push(getBinFileName(dim.strategy, dim.playerCount, dim.depthBb));
      manifest.files.push(getIdxFileName(dim.strategy, dim.playerCount, dim.depthBb));
    }

    await Bun.write(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

    // Update build_info in meta.db
    metaDb
      .prepare("INSERT OR REPLACE INTO build_info(key, value) VALUES (?, ?)")
      .run("built_at", manifest.builtAt);
    metaDb
      .prepare("INSERT OR REPLACE INTO build_info(key, value) VALUES (?, ?)")
      .run("source_checksum", sourceDbChecksum);
    metaDb.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");

    // Calculate total sizes
    let outputTotalSizeBytes = 0;
    let outputMetaDbSizeBytes = 0;
    try {
      const ms = await stat(metaPath);
      outputMetaDbSizeBytes = ms.size;
      outputTotalSizeBytes += ms.size;
    } catch { /* ignore */ }
    for (const s of dimensionStats) {
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
      dimensions: dimensionStats,
      totals: {
        dimensionCount: allDimensions.length,
        concreteLineCount: sum(dimensionStats.map((s) => s.concreteLineCount)),
        packCount: sum(dimensionStats.map((s) => s.packCount)),
        srcRowCount: sum(dimensionStats.map((s) => s.srcRowCount)),
        totalDurationMs: totalDuration,
        errorCount: dimensionStats.filter((s) => s.error).length,
      },
    };

    // Output stats if requested
    if (options.statsOutPath) {
      await mkdir(dirnameSafe(options.statsOutPath), { recursive: true });
      await Bun.write(options.statsOutPath, JSON.stringify(report, null, 2) + "\n");
    }

    if (options.statsMdPath) {
      await mkdir(dirnameSafe(options.statsMdPath), { recursive: true });
      await Bun.write(options.statsMdPath, renderBuildReportMarkdown(report));
    }

    // Print summary
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
  } finally {
    metaDb.close();
    sourceDb.close();
  }
}

function uniqueStrategies(dimensions: RangeDimension[]): string[] {
  return [...new Set(dimensions.map((dimension) => dimension.strategy))];
}

async function readBuildManifest(manifestPath: string): Promise<BuildManifest | null> {
  if (!existsSync(manifestPath)) return null;

  try {
    return JSON.parse(await Bun.file(manifestPath).text()) as BuildManifest;
  } catch {
    return null;
  }
}

async function cleanupPreviousOutput(params: {
  outDir: string;
  metaPath: string;
  manifestPath: string;
  manifest: BuildManifest | null;
  dimensions: RangeDimension[];
}): Promise<void> {
  const paths = new Set<string>([
    params.metaPath,
    `${params.metaPath}-wal`,
    `${params.metaPath}-shm`,
    params.manifestPath,
  ]);

  for (const file of params.manifest?.files ?? []) {
    if (file !== "meta.db") paths.add(join(params.outDir, file));
  }

  for (const dimension of params.dimensions) {
    const binFile = join(params.outDir, dimension.binFile);
    const idxFile = join(params.outDir, getIdxFileName(dimension.strategy, dimension.playerCount, dimension.depthBb));
    paths.add(binFile);
    paths.add(idxFile);
    paths.add(`${binFile}.tmp`);
    paths.add(`${idxFile}.tmp`);
  }

  for (const path of paths) {
    await removeFileWithRetry(path);
  }
}

async function removeFileWithRetry(path: string): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await rm(path, { force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw lastError;
}

async function collectCompletedManifestStats(manifest: BuildManifest, outDir: string): Promise<DimensionBuildStats[]> {
  const completed: DimensionBuildStats[] = [];

  for (const dimension of manifest.dimensions) {
    if (dimension.status !== "success") continue;

    const binFile = dimension.binFile ?? getBinFileName(dimension.strategy, dimension.playerCount, dimension.depthBb);
    const idxFile = dimension.idxFile ?? getIdxFileName(dimension.strategy, dimension.playerCount, dimension.depthBb);
    const binPath = join(outDir, binFile);
    const idxPath = join(outDir, idxFile);

    try {
      const binStat = await stat(binPath);
      const idxStat = await stat(idxPath);
      if (dimension.binFileSizeBytes !== undefined && dimension.binFileSizeBytes !== binStat.size) continue;
      if (dimension.idxFileSizeBytes !== undefined && dimension.idxFileSizeBytes !== idxStat.size) continue;

      completed.push({
        strategy: dimension.strategy,
        playerCount: dimension.playerCount,
        depthBb: dimension.depthBb,
        concreteLineCount: dimension.concreteLineCount,
        packCount: dimension.packCount,
        binFileSizeBytes: binStat.size,
        idxFileSizeBytes: idxStat.size,
        srcRowCount: 0,
        durationMs: 0,
        error: null,
      });
    } catch {
      // Missing or unreadable output is treated as incomplete and rebuilt.
    }
  }

  return completed;
}

function manifestDimensionKey(dimension: Pick<RangeDimension, "strategy" | "playerCount" | "depthBb">): string {
  return `${dimension.strategy}:${dimension.playerCount}:${dimension.depthBb}`;
}

interface DimensionBuildResult {
  packCount: number;
  concreteLineCount: number;
  srcRowCount: number;
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
  outDir: string;
  overwrite?: boolean;
  maxConcreteLines?: number;
  progressEveryPacks: number;
}): Promise<DimensionBuildResult> {
  const binBase = join(params.outDir, params.dimension.binFile);
  const idxBase = join(
    params.outDir,
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

  return `# Scheme2 Build Report

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
