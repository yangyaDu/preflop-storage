import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getBooleanArg, getNumberArg, getRepeatedStringArgs, getStringArg, parseCliArgs } from "../../cli/args";
import { dimensionKey, quoteIdentifier } from "../../db/naming";
import { parseRequestedDimension, type MemorySnapshot } from "../../benchmark/common";
import { formatBuildManifestIssues, parseBuildManifestJson } from "../compiler/manifest";
import type { BuildManifest, BuildManifestDimension } from "../compiler/types";
import type {
  ColdStartBenchmarkReport,
  ColdStartMode,
  ColdStartRunFailure,
  ColdStartRunResult,
  ColdWorkerTimings,
  DimensionColdStartReport,
  DimensionQuery,
  EvictionResult,
  QueryPolicy,
  WorkerResult,
} from "./cold/types";
import { evictCache } from "./cold/cache-eviction";
import { buildColdStartNotes, writeColdStartJson, writeColdStartMarkdown } from "./cold/report";
import {
  buildDimensionReport,
  computeAggregatePhaseAccounting,
  computePhaseAccounting,
  summarizeLatencies,
  summarizePhaseTimings,
} from "./cold/stats";

const args = parseCliArgs(Bun.argv.slice(2));
const sourceDbPath = getStringArg(args, "source", "range-db/range.db");
const binaryDir = getStringArg(args, "dir", "range-db/range-strata-binary");
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
  throw new Error("No successful Range Strata Binary dimensions were found for cold-start benchmark.");
}

const datasetSizeBytes = computeDatasetSize(binaryDir);
const queries = selectDimensionQueries(sourceDbPath, dimensions, queryOverride);
const report = await runColdStartBenchmark(queries, datasetSizeBytes);
await writeColdStartJson(outPath, report);
await writeColdStartMarkdown(mdPath, report);

console.log(`Range Strata Binary cold-start benchmark written: ${outPath}`);
console.log(`Range Strata Binary cold-start benchmark markdown written: ${mdPath}`);
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
    notes: buildColdStartNotes({
      queryPolicy,
      mode,
      cacheFillerSizeBytes: cacheFillerSizeMb * 1024 * 1024,
    }),
  };
}

async function runWorker(
  query: DimensionQuery,
  runIndex: number,
  eviction: EvictionResult,
): Promise<ColdStartRunResult> {
  const workerPath = join(import.meta.dir, "cold-worker.ts");
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdoutText);
  } catch (error) {
    return invalidWorkerResult(
      `Worker did not return valid JSON. exitCode=${exitCode}, error=${formatUnknownError(error)}, stdout=${stdoutText.slice(0, 500)}`,
    );
  }

  if (!isWorkerResult(parsed)) {
    return invalidWorkerResult(`Worker returned JSON with an unexpected shape. exitCode=${exitCode}, stdout=${stdoutText.slice(0, 500)}`);
  }

  return { ...parsed, _validJson: true };
}

function computeDatasetSize(dir: string): number {
  try {
    const entries = readdirSync(dir);
    let total = 0;
    for (const entry of entries) {
      try {
        total += statSync(join(dir, entry)).size;
      } catch (error) {
        warnRecoverable(`Skipping dataset size entry ${entry}`, error);
      }
    }
    return total;
  } catch (error) {
    warnRecoverable(`Could not list dataset directory ${dir}; dataset size will be 0`, error);
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
    throw new Error(`manifest.json was not found in ${dir}. Build Range Strata Binary output first.`);
  }

  const parsed = parseBuildManifestJson(readFileSync(manifestPath, "utf8"));
  if (!parsed.manifest) {
    throw new Error(`manifest.json is invalid: ${formatBuildManifestIssues(parsed.issues)}`);
  }

  const manifest: BuildManifest = parsed.manifest;
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

function invalidWorkerResult(error: string): WorkerResult & { _validJson: false } {
  return {
    ok: false,
    storeOpenAndFirstQueryMs: 0,
    resultCount: 0,
    memoryBefore: emptyMemorySnapshot(),
    memoryAfter: emptyMemorySnapshot(),
    timings: emptyWorkerTimings(),
    error,
    _validJson: false,
  };
}

function isWorkerResult(value: unknown): value is WorkerResult {
  if (!isRecord(value)) return false;
  return (
    typeof value.ok === "boolean" &&
    isFiniteNumber(value.storeOpenAndFirstQueryMs) &&
    isFiniteNumber(value.resultCount) &&
    isMemorySnapshot(value.memoryBefore) &&
    isMemorySnapshot(value.memoryAfter) &&
    isColdWorkerTimings(value.timings) &&
    (value.error === null || typeof value.error === "string")
  );
}

function isMemorySnapshot(value: unknown): value is MemorySnapshot {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.rssBytes) &&
    isFiniteNumber(value.heapTotalBytes) &&
    isFiniteNumber(value.heapUsedBytes) &&
    isFiniteNumber(value.externalBytes) &&
    isFiniteNumber(value.arrayBuffersBytes)
  );
}

function isColdWorkerTimings(value: unknown): value is ColdWorkerTimings {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.supportModuleImportMs) &&
    isFiniteNumber(value.argsParseMs) &&
    isFiniteNumber(value.queryServiceImportMs) &&
    isFiniteNumber(value.memorySnapshotMs) &&
    isFiniteNumber(value.serviceConstructorMs) &&
    isFiniteNumber(value.dimensionPrewarmMs) &&
    isFiniteNumber(value.firstQueryMs) &&
    isFiniteNumber(value.closeMs) &&
    isFiniteNumber(value.workerTotalMs)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function warnRecoverable(message: string, error: unknown): void {
  console.warn(`[cold-benchmark] ${message}: ${formatUnknownError(error)}`);
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
