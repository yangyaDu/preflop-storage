import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { formatBytes, markdownTable } from "../../analysis/format";
import { getBooleanArg, getNumberArg, getRepeatedStringArgs, getStringArg, parseCliArgs } from "../../cli/args";
import { dimensionKey, quoteIdentifier } from "../../db/naming";
import { parseRequestedDimension, type MemorySnapshot } from "../../benchmark/common";
import type { BuildManifest, BuildManifestDimension } from "../importer/build-binary-store";

type ColdStartMode = "process-cold" | "os-best-effort" | "linux-drop-cache";
type QueryPolicy = "first" | "fixed";

interface DimensionQuery {
  strategy: string;
  playerCount: number;
  depthBb: number;
  concreteLineId: number;
  hand: string;
}

interface WorkerResult {
  ok: boolean;
  storeOpenAndFirstQueryMs: number;
  resultCount: number;
  memoryBefore: MemorySnapshot;
  memoryAfter: MemorySnapshot;
  timings: ColdWorkerTimings;
  error: string | null;
}

interface ColdStartRunResult extends WorkerResult {
  runIndex: number;
  processElapsedMs: number;
  processOverheadMs: number;
  eviction: EvictionResult;
  stderr: string;
  exitCode: number;
  validJson: boolean;
  phaseAccounting: PhaseAccounting;
}

interface EvictionResult {
  requested: boolean;
  method: ColdStartMode;
  succeeded: boolean;
  durationMs: number;
  fillerSizeBytes: number;
  datasetSizeBytes: number;
  notes: string[];
}

interface LatencySummary {
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  avgMs: number;
}

interface PhaseAccounting {
  phaseSumMs: number;
  workerTotalMs: number;
  unaccountedMs: number;
  unaccountedRatio: number;
}

interface ColdStartRunFailure {
  runIndex: number;
  exitCode: number;
  error: string;
  stderr: string;
  validJson: boolean;
}

interface ColdWorkerTimings {
  supportModuleImportMs: number;
  argsParseMs: number;
  queryServiceImportMs: number;
  memorySnapshotMs: number;
  serviceConstructorMs: number;
  dimensionPrewarmMs: number;
  firstQueryMs: number;
  closeMs: number;
  workerTotalMs: number;
}

interface ColdStartPhaseSummaries {
  supportModuleImportMs: LatencySummary;
  argsParseMs: LatencySummary;
  queryServiceImportMs: LatencySummary;
  memorySnapshotMs: LatencySummary;
  serviceConstructorMs: LatencySummary;
  dimensionPrewarmMs: LatencySummary;
  firstQueryMs: LatencySummary;
  closeMs: LatencySummary;
  workerTotalMs: LatencySummary;
  processOverheadMs: LatencySummary;
}

interface DimensionColdStartReport {
  dimension: string;
  query: DimensionQuery;
  runs: number;
  successCount: number;
  errorCount: number;
  resultCount: number;
  storeOpenAndFirstQueryMs: LatencySummary;
  processElapsedMs: LatencySummary;
  phaseTimings: ColdStartPhaseSummaries;
  memoryDeltaRssBytes: LatencySummary;
  phaseAccounting: PhaseAccounting;
  failures: ColdStartRunFailure[];
  parentRssSamples: number[];
  results: ColdStartRunResult[];
}

interface ColdStartBenchmarkReport {
  generatedAt: string;
  mode: ColdStartMode;
  platform: NodeJS.Platform;
  runsPerDimension: number;
  sourceDbPath: string;
  binaryDir: string;
  metaDbPath: string;
  verifyChecksums: boolean;
  cacheFillerSizeBytes: number;
  dimensions: DimensionColdStartReport[];
  aggregate: {
    dimensions: number;
    runs: number;
    successfulRuns: number;
    errorCount: number;
    storeOpenAndFirstQueryMs: LatencySummary;
    processElapsedMs: LatencySummary;
    phaseTimings: ColdStartPhaseSummaries;
    phaseAccounting: PhaseAccounting;
    failures: ColdStartRunFailure[];
    parentRssSamples: number[];
  };
  notes: string[];
}

const args = parseCliArgs(Bun.argv.slice(2));
const sourceDbPath = getStringArg(args, "source", "range-db/range.db");
const binaryDir = getStringArg(args, "dir", "range-db/binary-scheme2");
const metaDbPath = getStringArg(args, "meta", join(binaryDir, "meta.db"));
const mode = parseMode(getStringArg(args, "mode", "process-cold"));
const runsPerDimension =
  args["runs-per-dimension"] !== undefined ? getNumberArg(args, "runs-per-dimension") : getNumberArg(args, "runs", 10);
const outPath = getStringArg(args, "out", "reports/benchmark-cold-start.json");
const mdPath = getStringArg(args, "md", "reports/benchmark-cold-start.md");
const verifyChecksums = getBooleanArg(args, "verify-checksum");
const cacheFillerSizeMb = getNumberArg(args, "cache-filler-mb", process.platform === "win32" ? 256 : 512);
const requestedDimensions = getRepeatedStringArgs(args, "dimension").map(parseRequestedDimension);
const queryPolicy = parseQueryPolicy(getStringArg(args, "query-policy", "first"));
const queryOverride = parseQueryOverride(queryPolicy);
const maxErrorsPerDimension = getNumberArg(args, "max-errors-per-dimension", Number.POSITIVE_INFINITY);
const failFast = getBooleanArg(args, "fail-fast");

if (runsPerDimension <= 0 || !Number.isInteger(runsPerDimension)) {
  throw new Error(`--runs-per-dimension must be a positive integer, got ${runsPerDimension}`);
}

const dimensions = filterRequestedDimensions(readSuccessfulDimensions(binaryDir), requestedDimensions);
if (dimensions.length === 0) {
  throw new Error("No successful Scheme2 dimensions were found for cold-start benchmark.");
}

const datasetSizeBytes = computeDatasetSize(binaryDir);
const queries = selectDimensionQueries(sourceDbPath, dimensions, queryOverride);
const report = await runColdStartBenchmark(queries, datasetSizeBytes);
await writeColdStartJson(outPath, report);
await writeColdStartMarkdown(mdPath, report);

console.log(`Scheme2 cold-start benchmark written: ${outPath}`);
console.log(`Scheme2 cold-start benchmark markdown written: ${mdPath}`);
console.log(`Dimensions: ${report.aggregate.dimensions}, runs: ${report.aggregate.runs}, errors: ${report.aggregate.errorCount}`);

if (report.aggregate.errorCount > 0) {
  process.exitCode = 1;
}

async function runColdStartBenchmark(
  queries: DimensionQuery[],
  datasetSize: number,
): Promise<ColdStartBenchmarkReport> {
  const dimensionsReport: DimensionColdStartReport[] = [];
  const parentRssSamples: number[] = [];

  for (const query of queries) {
    const results: ColdStartRunResult[] = [];
    for (let runIndex = 0; runIndex < runsPerDimension; runIndex++) {
      const eviction = await evictCache(mode, cacheFillerSizeMb * 1024 * 1024, datasetSize);
      const runResult = await runWorker(query, runIndex, eviction);
      results.push(runResult);

      const dimensionErrors = results.filter((r) => !r.ok).length;
      if (failFast && !runResult.ok) {
        break;
      }
      if (dimensionErrors >= maxErrorsPerDimension) {
        break;
      }
    }
    const dimensionReport = buildDimensionReport(query, results);
    dimensionsReport.push(dimensionReport);
    parentRssSamples.push(process.memoryUsage().rss);
  }

  const allResults = dimensionsReport.flatMap((dimension) => dimension.results);
  const allOkResults = allResults.filter((r) => r.ok);
  const allFailures: ColdStartRunFailure[] = [];
  for (const dimension of dimensionsReport) {
    for (const failure of dimension.failures) {
      allFailures.push(failure);
    }
  }

  const aggregatePhaseAccounting = computeAggregatePhaseAccounting(allOkResults);
  return {
    generatedAt: new Date().toISOString(),
    mode,
    platform: process.platform,
    runsPerDimension,
    sourceDbPath,
    binaryDir,
    metaDbPath,
    verifyChecksums,
    cacheFillerSizeBytes: cacheFillerSizeMb * 1024 * 1024,
    dimensions: dimensionsReport,
    aggregate: {
      dimensions: dimensionsReport.length,
      runs: allResults.length,
      successfulRuns: allOkResults.length,
      errorCount: allResults.filter((result) => !result.ok).length,
      storeOpenAndFirstQueryMs: summarizeLatencies(allOkResults.map((r) => r.storeOpenAndFirstQueryMs)),
      processElapsedMs: summarizeLatencies(allOkResults.map((r) => r.processElapsedMs)),
      phaseTimings: summarizePhaseTimings(allOkResults),
      phaseAccounting: aggregatePhaseAccounting,
      failures: allFailures,
      parentRssSamples,
    },
    notes: buildNotes(),
  };
}

async function runWorker(
  query: DimensionQuery,
  runIndex: number,
  eviction: EvictionResult,
): Promise<ColdStartRunResult> {
  const workerPath = join(import.meta.dir, "benchmark-cold-worker.ts");
  const command = [
    process.execPath,
    workerPath,
    "--dir",
    binaryDir,
    "--meta",
    metaDbPath,
    "--strategy",
    query.strategy,
    "--player-count",
    String(query.playerCount),
    "--depth-bb",
    String(query.depthBb),
    "--concrete-line-id",
    String(query.concreteLineId),
    "--hand",
    query.hand,
    ...(verifyChecksums ? ["--verify-checksum"] : []),
  ];

  const start = performance.now();
  const proc = Bun.spawn(command, {
    cwd: join(import.meta.dir, "..", "..", ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  const processElapsedMs = performance.now() - start;
  const stdoutText = (await stdout).trim();
  const stderrText = await stderr;
  const parsed = parseWorkerResult(stdoutText, exitCode);
  const validJson = parsed._validJson !== false;
  const combinedOk = parsed.ok && exitCode === 0 && validJson;
  const phaseAccounting = computePhaseAccounting(parsed.timings);

  return {
    ...parsed,
    ok: combinedOk,
    runIndex,
    processElapsedMs,
    processOverheadMs: Math.max(0, processElapsedMs - parsed.timings.workerTotalMs),
    eviction,
    stderr: stderrText,
    exitCode,
    validJson,
    phaseAccounting,
  };
}

function parseWorkerResult(stdoutText: string, exitCode: number): WorkerResult & { _validJson: boolean } {
  try {
    return { ...JSON.parse(stdoutText) as WorkerResult, _validJson: true };
  } catch {
    return {
      ok: false,
      storeOpenAndFirstQueryMs: 0,
      resultCount: 0,
      memoryBefore: emptyMemorySnapshot(),
      memoryAfter: emptyMemorySnapshot(),
      timings: emptyWorkerTimings(),
      error: `Worker did not return valid JSON. exitCode=${exitCode}, stdout=${stdoutText.slice(0, 500)}`,
      _validJson: false,
    };
  }
}

async function evictCache(
  cacheMode: ColdStartMode,
  fillerSizeBytes: number,
  datasetSizeBytes: number,
): Promise<EvictionResult> {
  if (cacheMode === "process-cold") {
    return {
      requested: false,
      method: cacheMode,
      succeeded: true,
      durationMs: 0,
      fillerSizeBytes: 0,
      datasetSizeBytes,
      notes: ["OS page cache eviction was not requested."],
    };
  }

  if (cacheMode === "linux-drop-cache") {
    return evictLinuxDropCaches();
  }

  return evictBestEffortFileCache(fillerSizeBytes, datasetSizeBytes);
}

async function evictLinuxDropCaches(): Promise<EvictionResult> {
  const start = performance.now();
  if (process.platform !== "linux") {
    return {
      requested: true,
      method: "linux-drop-cache",
      succeeded: false,
      durationMs: performance.now() - start,
      fillerSizeBytes: 0,
      datasetSizeBytes,
      notes: ["linux-drop-cache mode is only available on Linux."],
    };
  }

  try {
    await Bun.spawn(["sync"]).exited;
    await Bun.write("/proc/sys/vm/drop_caches", "3\n");
    return {
      requested: true,
      method: "linux-drop-cache",
      succeeded: true,
      durationMs: performance.now() - start,
      fillerSizeBytes: 0,
      datasetSizeBytes,
      notes: ["Wrote 3 to /proc/sys/vm/drop_caches after sync."],
    };
  } catch (error) {
    return {
      requested: true,
      method: "linux-drop-cache",
      succeeded: false,
      durationMs: performance.now() - start,
      fillerSizeBytes: 0,
      datasetSizeBytes,
      notes: [`Could not drop Linux page cache: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

async function evictBestEffortFileCache(fillerSizeBytes: number, datasetSizeBytes: number): Promise<EvictionResult> {
  const start = performance.now();
  const fillerPath = join(tmpdir(), `preflop-cold-cache-${process.pid}.bin`);
  const chunk = new Uint8Array(1024 * 1024);
  // Fill with deterministic non-zero pattern to avoid OS zero-page dedup
  for (let i = 0; i < chunk.byteLength; i++) {
    chunk[i] = (i & 0xFF) ^ 0xAA;
  }

  try {
    const writer = await open(fillerPath, "w");
    try {
      let written = 0;
      while (written < fillerSizeBytes) {
        const length = Math.min(chunk.byteLength, fillerSizeBytes - written);
        await writer.write(chunk.subarray(0, length), 0, length, written);
        written += length;
      }
    } finally {
      await writer.close();
    }

    const reader = await open(fillerPath, "r");
    try {
      const readBuffer = Buffer.allocUnsafe(1024 * 1024);
      let read = 0;
      while (read < fillerSizeBytes) {
        const result = await reader.read(readBuffer, 0, readBuffer.length, read);
        if (result.bytesRead === 0) break;
        read += result.bytesRead;
      }
    } finally {
      await reader.close();
    }

    await rm(fillerPath, { force: true });
    const ratio = datasetSizeBytes > 0 ? fillerSizeBytes / datasetSizeBytes : 0;
    return {
      requested: true,
      method: "os-best-effort",
      succeeded: true,
      durationMs: performance.now() - start,
      fillerSizeBytes,
      datasetSizeBytes,
      notes: [
        `Filled OS file cache with ${formatBytes(fillerSizeBytes)} non-zero filler (filler/dataset = ${ratio.toFixed(1)}x). This is best-effort perturbation and does not guarantee a true cold cache.`,
      ],
    };
  } catch (error) {
    await rm(fillerPath, { force: true }).catch(() => {});
    return {
      requested: true,
      method: "os-best-effort",
      succeeded: false,
      durationMs: performance.now() - start,
      fillerSizeBytes,
      datasetSizeBytes,
      notes: [`Best-effort cache perturbation failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

function buildDimensionReport(query: DimensionQuery, results: ColdStartRunResult[]): DimensionColdStartReport {
  const okResults = results.filter((r) => r.ok);
  const failures: ColdStartRunFailure[] = results
    .filter((r) => !r.ok)
    .map((r) => ({
      runIndex: r.runIndex,
      exitCode: r.exitCode,
      error: r.error ?? "Unknown error",
      stderr: r.stderr,
      validJson: r.validJson,
    }));

  return {
    dimension: dimensionKey(query),
    query,
    runs: results.length,
    successCount: okResults.length,
    errorCount: results.length - okResults.length,
    resultCount: results.reduce((total, r) => total + r.resultCount, 0),
    storeOpenAndFirstQueryMs: summarizeLatencies(okResults.map((r) => r.storeOpenAndFirstQueryMs)),
    processElapsedMs: summarizeLatencies(okResults.map((r) => r.processElapsedMs)),
    phaseTimings: summarizePhaseTimings(okResults),
    memoryDeltaRssBytes: summarizeLatencies(
      okResults.map((r) => r.memoryAfter.rssBytes - r.memoryBefore.rssBytes),
    ),
    phaseAccounting: computeAggregatePhaseAccounting(okResults),
    failures,
    parentRssSamples: [],
    results,
  };
}

function summarizePhaseTimings(results: ColdStartRunResult[]): ColdStartPhaseSummaries {
  return {
    supportModuleImportMs: summarizeLatencies(results.map((result) => result.timings.supportModuleImportMs)),
    argsParseMs: summarizeLatencies(results.map((result) => result.timings.argsParseMs)),
    queryServiceImportMs: summarizeLatencies(results.map((result) => result.timings.queryServiceImportMs)),
    memorySnapshotMs: summarizeLatencies(results.map((result) => result.timings.memorySnapshotMs)),
    serviceConstructorMs: summarizeLatencies(results.map((result) => result.timings.serviceConstructorMs)),
    dimensionPrewarmMs: summarizeLatencies(results.map((result) => result.timings.dimensionPrewarmMs)),
    firstQueryMs: summarizeLatencies(results.map((result) => result.timings.firstQueryMs)),
    closeMs: summarizeLatencies(results.map((result) => result.timings.closeMs)),
    workerTotalMs: summarizeLatencies(results.map((result) => result.timings.workerTotalMs)),
    processOverheadMs: summarizeLatencies(results.map((result) => result.processOverheadMs)),
  };
}

function summarizeLatencies(values: number[]): LatencySummary {
  if (values.length === 0) {
    return { minMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, avgMs: 0 };
  }

  const sorted = [...values].sort((left, right) => left - right);
  const total = values.reduce((sum, value) => sum + value, 0);

  return {
    minMs: sorted[0],
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1],
    avgMs: total / values.length,
  };
}

function percentile(sortedValues: number[], quantile: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * quantile) - 1));
  return sortedValues[index];
}

function computePhaseAccounting(timings: ColdWorkerTimings): PhaseAccounting {
  const phaseSumMs =
    timings.supportModuleImportMs +
    timings.argsParseMs +
    timings.queryServiceImportMs +
    timings.memorySnapshotMs +
    timings.serviceConstructorMs +
    timings.dimensionPrewarmMs +
    timings.firstQueryMs +
    timings.closeMs;
  const unaccountedMs = timings.workerTotalMs - phaseSumMs;
  const unaccountedRatio = timings.workerTotalMs > 0 ? Math.abs(unaccountedMs) / timings.workerTotalMs : 0;
  return { phaseSumMs, workerTotalMs: timings.workerTotalMs, unaccountedMs, unaccountedRatio };
}

function computeAggregatePhaseAccounting(results: ColdStartRunResult[]): PhaseAccounting {
  if (results.length === 0) {
    return { phaseSumMs: 0, workerTotalMs: 0, unaccountedMs: 0, unaccountedRatio: 0 };
  }
  // Take the run with the largest absolute unaccountedMs as the representative
  let worst = results[0].phaseAccounting;
  for (let i = 1; i < results.length; i++) {
    if (Math.abs(results[i].phaseAccounting.unaccountedMs) > Math.abs(worst.unaccountedMs)) {
      worst = results[i].phaseAccounting;
    }
  }
  return worst;
}

function computeDatasetSize(dir: string): number {
  try {
    const entries = readdirSync(dir);
    let total = 0;
    for (const entry of entries) {
      try {
        total += statSync(join(dir, entry)).size;
      } catch {
        // Skip files that disappear
      }
    }
    return total;
  } catch {
    return 0;
  }
}

function parseQueryPolicy(value: string): QueryPolicy {
  if (value === "first" || value === "fixed") return value;
  throw new Error(`Invalid --query-policy value: ${value}. Use first or fixed.`);
}

function selectDimensionQueries(
  sourcePath: string,
  dimensionsToQuery: BuildManifestDimension[],
  override: { concreteLineId: number; hand: string } | null,
): DimensionQuery[] {
  const db = new Database(sourcePath, { readonly: true });
  try {
    return dimensionsToQuery.map((dimension) => {
      const rangeTable = `range_data_${dimension.strategy}_${dimension.playerCount}max_${dimension.depthBb}BB`;
      const row = override
        ? (db
            .query(`
              SELECT concrete_line_id, hole_cards
              FROM ${quoteIdentifier(rangeTable)}
              WHERE concrete_line_id = ?
                AND hole_cards = ?
              ORDER BY id
              LIMIT 1
            `)
            .get(override.concreteLineId, override.hand) as { concrete_line_id: number; hole_cards: string } | null)
        : (db
            .query(`
              SELECT concrete_line_id, hole_cards
              FROM ${quoteIdentifier(rangeTable)}
              ORDER BY concrete_line_id, id
              LIMIT 1
            `)
            .get() as { concrete_line_id: number; hole_cards: string } | null);

      if (!row) {
        const overrideDetail = override ? ` using concrete_line_id=${override.concreteLineId}, hand=${override.hand}` : "";
        throw new Error(`Could not find a source query row for dimension ${dimensionKey(dimension)}${overrideDetail}.`);
      }

      return {
        strategy: dimension.strategy,
        playerCount: dimension.playerCount,
        depthBb: dimension.depthBb,
        concreteLineId: row.concrete_line_id,
        hand: row.hole_cards,
      };
    });
  } finally {
    db.close();
  }
}

function parseQueryOverride(policy: QueryPolicy): { concreteLineId: number; hand: string } | null {
  if (policy === "first") return null;

  const hasConcreteLineId = args["concrete-line-id"] !== undefined;
  const hasHand = args.hand !== undefined;
  if (!hasConcreteLineId || !hasHand) {
    throw new Error("--query-policy fixed requires both --concrete-line-id and --hand.");
  }

  return {
    concreteLineId: getNumberArg(args, "concrete-line-id"),
    hand: getStringArg(args, "hand"),
  };
}

function readSuccessfulDimensions(dir: string): BuildManifestDimension[] {
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest.json was not found in ${dir}. Build Scheme2 output first.`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BuildManifest;
  return manifest.dimensions
    .filter((dimension) => dimension.status !== "failed")
    .sort((left, right) => dimensionKey(left).localeCompare(dimensionKey(right)));
}

function filterRequestedDimensions(
  dimensionsToFilter: BuildManifestDimension[],
  requested: Array<{ strategy: string; playerCount: number; depthBb: number }>,
): BuildManifestDimension[] {
  if (requested.length === 0) return dimensionsToFilter;
  return dimensionsToFilter.filter((dimension) =>
    requested.some(
      (item) =>
        item.strategy === dimension.strategy &&
        item.playerCount === dimension.playerCount &&
        item.depthBb === dimension.depthBb,
    ),
  );
}

async function writeColdStartJson(path: string, reportToWrite: ColdStartBenchmarkReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(reportToWrite, null, 2)}\n`);
}

async function writeColdStartMarkdown(path: string, reportToWrite: ColdStartBenchmarkReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, renderColdStartMarkdown(reportToWrite));
}

function renderColdStartMarkdown(reportToRender: ColdStartBenchmarkReport): string {
  const rows = reportToRender.dimensions.map((dimension) => [
    dimension.dimension,
    dimension.runs,
    dimension.errorCount,
    formatMs(dimension.storeOpenAndFirstQueryMs.p50Ms),
    formatMs(dimension.storeOpenAndFirstQueryMs.p95Ms),
    formatMs(dimension.processElapsedMs.p50Ms),
    formatMs(dimension.processElapsedMs.p95Ms),
    formatBytes(dimension.memoryDeltaRssBytes.p95Ms),
    `${dimension.query.concreteLineId} / ${dimension.query.hand}`,
  ]);
  const aggregatePhaseRows = phaseSummaryRows(reportToRender.aggregate.phaseTimings);
  const dimensionPhaseRows = reportToRender.dimensions.map((dimension) => [
    dimension.dimension,
    formatMs(dimension.phaseTimings.queryServiceImportMs.p95Ms),
    formatMs(dimension.phaseTimings.serviceConstructorMs.p95Ms),
    formatMs(dimension.phaseTimings.dimensionPrewarmMs.p95Ms),
    formatMs(dimension.phaseTimings.firstQueryMs.p95Ms),
    formatMs(dimension.phaseTimings.workerTotalMs.p95Ms),
    formatMs(dimension.phaseTimings.processOverheadMs.p95Ms),
  ]);

  return `# Scheme2 Cold-Start Benchmark

Generated: ${reportToRender.generatedAt}

## Summary

- Mode: ${reportToRender.mode}
- Platform: ${reportToRender.platform}
- Source DB: \`${reportToRender.sourceDbPath}\`
- Binary dir: \`${reportToRender.binaryDir}\`
- meta.db: \`${reportToRender.metaDbPath}\`
- Dimensions: ${reportToRender.aggregate.dimensions}
- Runs per dimension: ${reportToRender.runsPerDimension}
- Total runs: ${reportToRender.aggregate.runs}
- Errors: ${reportToRender.aggregate.errorCount}
- Cache filler size: ${formatBytes(reportToRender.cacheFillerSizeBytes)}
- Successful runs: ${reportToRender.aggregate.successfulRuns}
- Aggregate store open + first query p50 / p95: ${formatMs(reportToRender.aggregate.storeOpenAndFirstQueryMs.p50Ms)} / ${formatMs(reportToRender.aggregate.storeOpenAndFirstQueryMs.p95Ms)}
- Aggregate process elapsed p50 / p95: ${formatMs(reportToRender.aggregate.processElapsedMs.p50Ms)} / ${formatMs(reportToRender.aggregate.processElapsedMs.p95Ms)}
- Phase accounting (worst): unaccounted ${formatMs(reportToRender.aggregate.phaseAccounting.unaccountedMs)} (${(reportToRender.aggregate.phaseAccounting.unaccountedRatio * 100).toFixed(2)}%)

## Aggregate Phase Breakdown

${markdownTable(["Phase", "P50", "P95", "Avg", "Max"], aggregatePhaseRows)}

## Dimensions

${markdownTable(
  [
    "Dimension",
    "Runs",
    "Errors",
    "Store Open+Query P50",
    "Store Open+Query P95",
    "Process P50",
    "Process P95",
    "RSS Delta P95",
    "Query",
  ],
  rows,
)}

## Failures

${
  reportToRender.aggregate.failures.length === 0
    ? "None\n"
    : markdownTable(
        ["Dimension", "Run", "Exit Code", "Valid JSON", "Error"],
        reportToRender.dimensions.flatMap((dim) =>
          dim.failures.map((failure) =>
            [dim.dimension, failure.runIndex, failure.exitCode, failure.validJson, failure.error].map(String),
          ),
        ),
      )
}

## Dimension Phase Breakdown

${markdownTable(
  [
    "Dimension",
    "QueryService Import P95",
    "Service Ctor P95",
    "Dimension Prewarm P95",
    "First Query P95",
    "Worker Total P95",
    "Process Overhead P95",
  ],
  dimensionPhaseRows,
)}

## Notes

${reportToRender.notes.map((note) => `- ${note}`).join("\n")}
`;
}

function phaseSummaryRows(summary: ColdStartPhaseSummaries): string[][] {
  const rows: Array<[string, LatencySummary]> = [
    ["Support module import", summary.supportModuleImportMs],
    ["CLI args parse", summary.argsParseMs],
    ["QueryService/native import", summary.queryServiceImportMs],
    ["Memory snapshot", summary.memorySnapshotMs],
    ["Service constructor (meta.db open)", summary.serviceConstructorMs],
    ["Dimension prewarm (idx/bin mmap + schema preload)", summary.dimensionPrewarmMs],
    ["First query sync decode", summary.firstQueryMs],
    ["Service close", summary.closeMs],
    ["Worker measured total", summary.workerTotalMs],
    ["Parent process overhead", summary.processOverheadMs],
  ];

  return rows.map(([name, summaryTimings]) => {
    return [
      name,
      formatMs(summaryTimings.p50Ms),
      formatMs(summaryTimings.p95Ms),
      formatMs(summaryTimings.avgMs),
      formatMs(summaryTimings.maxMs),
    ];
  });
}

function buildNotes(): string[] {
  const notes = [
    "Each run starts a fresh Bun worker process and records worker phase timings plus parent-observed process elapsed time.",
    "Default dimension selection uses all successful dimensions from manifest.json, so a full production output should cover all 9 dimensions.",
    "storeOpenAndFirstQueryMs = Scheme2 store open + dimension prewarm + first query, excluding module/runtime import. Use processElapsedMs or workerTotalMs for end-to-end cold start.",
    "QueryService/native import includes dynamic import of the Scheme2 query service and native addon loading.",
    "Dimension prewarm includes opening/mmaping the dimension .idx/.bin files and preloading the action schemas referenced by that dimension.",
    "Parent process overhead is parent-observed process elapsed time minus worker-measured total; it approximates Bun startup/shutdown and IPC overhead.",
    "Phase accounting records the difference between the sum of individual phase timings and workerTotalMs. A discrepancy > 1ms or ratio > 1% should be investigated.",
    `Query policy: ${queryPolicy}. Use --query-policy first (default, smoke test) or --query-policy fixed with --concrete-line-id/--hand. Roadmap: round-robin, random, stratified.`,
  ];

  if (mode === "process-cold") {
    notes.push("process-cold does not attempt OS page cache eviction; it measures fresh process/open/query cost with whatever cache state the OS currently has.");
  } else if (mode === "os-best-effort") {
    notes.push(
      `os-best-effort writes and reads a ${formatBytes(cacheFillerSizeMb * 1024 * 1024)} non-zero filler file to perturb OS page cache. Succeeded means perturbation completed, NOT that .idx/.bin files were evicted. This is a best-effort cache perturbation, not a guaranteed cold cache.`,
    );
  } else {
    notes.push("linux-drop-cache attempts sync + /proc/sys/vm/drop_caches and requires Linux with sufficient privileges.");
  }

  return notes;
}

function formatMs(value: number): string {
  if (!Number.isFinite(value)) return "unknown";
  return `${value.toFixed(value >= 10 ? 2 : 3)} ms`;
}

function parseMode(value: string): ColdStartMode {
  if (value === "process-cold" || value === "os-best-effort" || value === "linux-drop-cache") return value;
  throw new Error(`Invalid --mode value: ${value}. Use process-cold, os-best-effort, or linux-drop-cache.`);
}

function emptyMemorySnapshot(): MemorySnapshot {
  return {
    rssBytes: 0,
    heapTotalBytes: 0,
    heapUsedBytes: 0,
    externalBytes: 0,
    arrayBuffersBytes: 0,
  };
}

function emptyWorkerTimings(): ColdWorkerTimings {
  return {
    supportModuleImportMs: 0,
    argsParseMs: 0,
    queryServiceImportMs: 0,
    memorySnapshotMs: 0,
    serviceConstructorMs: 0,
    dimensionPrewarmMs: 0,
    firstQueryMs: 0,
    closeMs: 0,
    workerTotalMs: 0,
  };
}
