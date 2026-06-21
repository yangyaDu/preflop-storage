import { Database } from "bun:sqlite";
import { mkdir, stat } from "node:fs/promises";
import { getBinFileName, type RangeDimension } from "../../db/naming";
import { getIdxFileName } from "../catalog/naming";
import type {
  BuildManifest,
  BuildRangeStrataBinaryStoreOptions,
  BuildReport,
  DimensionBuildStats,
} from "./types";

export async function writeManifestAndReport(params: {
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
  } catch (error) {
    warnRecoverable("Could not stat output meta.db; report meta size will be 0", error);
  }
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

function warnRecoverable(message: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.warn(`[build] ${message}: ${detail}`);
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
