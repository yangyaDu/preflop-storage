import type { RangeDimension } from "../../db/naming";

export interface BuildRangeStrataBinaryStoreOptions {
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
