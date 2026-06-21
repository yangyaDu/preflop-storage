import type { MemorySnapshot } from "../../../benchmark/common";

export type ColdStartMode = "process-cold" | "os-best-effort" | "linux-drop-cache";
export type QueryPolicy = "first" | "fixed";

export interface DimensionQuery {
  strategy: string;
  playerCount: number;
  depthBb: number;
  concreteLineId: number;
  hand: string;
}

export interface WorkerResult {
  ok: boolean;
  storeOpenAndFirstQueryMs: number;
  resultCount: number;
  memoryBefore: MemorySnapshot;
  memoryAfter: MemorySnapshot;
  timings: ColdWorkerTimings;
  error: string | null;
}

export interface ColdStartRunResult extends WorkerResult {
  runIndex: number;
  processElapsedMs: number;
  processOverheadMs: number;
  eviction: EvictionResult;
  stderr: string;
  exitCode: number;
  validJson: boolean;
  phaseAccounting: PhaseAccounting;
}

export interface EvictionResult {
  requested: boolean;
  method: ColdStartMode;
  succeeded: boolean;
  durationMs: number;
  fillerSizeBytes: number;
  datasetSizeBytes: number;
  notes: string[];
}

export interface LatencySummary {
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  avgMs: number;
}

export interface PhaseAccounting {
  phaseSumMs: number;
  workerTotalMs: number;
  unaccountedMs: number;
  unaccountedRatio: number;
}

export interface ColdStartRunFailure {
  runIndex: number;
  exitCode: number;
  error: string;
  stderr: string;
  validJson: boolean;
}

export interface ColdWorkerTimings {
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

export interface ColdStartPhaseSummaries {
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

export interface DimensionColdStartReport {
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

export interface ColdStartBenchmarkReport {
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
