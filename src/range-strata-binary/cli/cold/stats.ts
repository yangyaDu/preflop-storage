import { dimensionKey } from "../../../db/naming";
import type {
  ColdStartPhaseSummaries,
  ColdStartRunFailure,
  ColdStartRunResult,
  ColdWorkerTimings,
  DimensionColdStartReport,
  DimensionQuery,
  LatencySummary,
  PhaseAccounting,
} from "./types";

export function buildDimensionReport(query: DimensionQuery, results: ColdStartRunResult[]): DimensionColdStartReport {
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

export function summarizePhaseTimings(results: ColdStartRunResult[]): ColdStartPhaseSummaries {
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

export function summarizeLatencies(values: number[]): LatencySummary {
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

export function computePhaseAccounting(timings: ColdWorkerTimings): PhaseAccounting {
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

export function computeAggregatePhaseAccounting(results: ColdStartRunResult[]): PhaseAccounting {
  if (results.length === 0) {
    return { phaseSumMs: 0, workerTotalMs: 0, unaccountedMs: 0, unaccountedRatio: 0 };
  }

  let worst = results[0].phaseAccounting;
  for (let i = 1; i < results.length; i++) {
    if (Math.abs(results[i].phaseAccounting.unaccountedMs) > Math.abs(worst.unaccountedMs)) {
      worst = results[i].phaseAccounting;
    }
  }
  return worst;
}

function percentile(sortedValues: number[], quantile: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * quantile) - 1));
  return sortedValues[index];
}
