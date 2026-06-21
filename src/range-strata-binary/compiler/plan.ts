import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { getBinFileName, type RangeDimension } from "../../db/naming";
import { PreflopStoreError } from "../../query/errors";
import { getIdxFileName } from "../catalog/naming";
import type { BuildManifest, DimensionBuildStats } from "./types";

interface ResolveBuildPlanOptions {
  rangeStrataStoreDir: string;
  overwrite?: boolean;
  resume?: boolean;
}

export type BuildPlanMode = "fresh" | "resume" | "overwrite";

export interface BuildPlan {
  mode: BuildPlanMode;
  shouldResetStoreArtifacts: boolean;
  reusableCompletedDimensionStats: DimensionBuildStats[];
  pendingRangeDimensions: RangeDimension[];
}

export async function resolveBuildPlan(params: {
  options: ResolveBuildPlanOptions;
  metaDbPath: string;
  previousManifest: BuildManifest | null;
  sourceRangeDbChecksum: string;
  targetRangeDimensions: RangeDimension[];
}): Promise<BuildPlan> {
  const { options, metaDbPath, previousManifest, sourceRangeDbChecksum, targetRangeDimensions } = params;
  const metaExists = existsSync(metaDbPath);

  if (metaExists && !options.overwrite) {
    if (options.resume && previousManifest) {
      // Resume mode can continue with the existing meta.db.
    } else if (options.resume) {
      throw new PreflopStoreError("BUILD_ERROR", "meta.db exists but manifest.json is missing or unreadable. Pass --overwrite to rebuild from scratch.", { metaDbPath });
    } else {
      throw new PreflopStoreError("BUILD_ERROR", `Output meta DB already exists: ${metaDbPath}. Pass --overwrite to rebuild it or --resume to continue.`, { metaDbPath });
    }
  }

  if (options.resume && previousManifest && !options.overwrite) {
    assertResumeSourceChecksum(previousManifest, sourceRangeDbChecksum);
  }

  const shouldBuildFromCleanStore = Boolean(options.overwrite) || !metaExists;
  const mode: BuildPlanMode = options.overwrite ? "overwrite" : options.resume && !shouldBuildFromCleanStore ? "resume" : "fresh";
  const knownDimensionKeys = new Set(targetRangeDimensions.map((dimension) => manifestDimensionKey(dimension)));
  const reusableCompletedDimensionStats = mode === "resume" && previousManifest
    ? await collectCompletedManifestStats(previousManifest, options.rangeStrataStoreDir, knownDimensionKeys)
    : [];
  const completedDimKeys = new Set(reusableCompletedDimensionStats.map((dimension) => manifestDimensionKey(dimension)));
  const pendingRangeDimensions = mode === "resume"
    ? targetRangeDimensions.filter((dimension) => !completedDimKeys.has(manifestDimensionKey(dimension)))
    : targetRangeDimensions;

  return {
    mode,
    shouldResetStoreArtifacts: mode !== "resume",
    reusableCompletedDimensionStats,
    pendingRangeDimensions,
  };
}

function assertResumeSourceChecksum(previousManifest: BuildManifest, sourceRangeDbChecksum: string): void {
  const previousChecksum = previousManifest.sourceDbChecksum;
  if (!previousChecksum || previousChecksum === "unknown" || sourceRangeDbChecksum === "unknown") {
    return;
  }

  if (previousChecksum !== sourceRangeDbChecksum) {
    throw new PreflopStoreError(
      "BUILD_ERROR",
      "Source DB checksum differs from manifest.json. Refusing --resume because completed dimensions may be stale. Pass --overwrite to rebuild from scratch.",
      {
        manifestChecksum: previousChecksum,
        sourceRangeDbChecksum,
      },
    );
  }
}

async function collectCompletedManifestStats(
  manifest: BuildManifest,
  rangeStrataStoreDir: string,
  knownDimensionKeys: Set<string>,
): Promise<DimensionBuildStats[]> {
  const completed: DimensionBuildStats[] = [];

  for (const dimension of manifest.dimensions) {
    if (dimension.status !== "success") continue;
    if (!knownDimensionKeys.has(manifestDimensionKey(dimension))) continue;

    const binFile = dimension.binFile ?? getBinFileName(dimension.strategy, dimension.playerCount, dimension.depthBb);
    const idxFile = dimension.idxFile ?? getIdxFileName(dimension.strategy, dimension.playerCount, dimension.depthBb);
    const binPath = join(rangeStrataStoreDir, binFile);
    const idxPath = join(rangeStrataStoreDir, idxFile);

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
    } catch (error) {
      console.warn(
        `[build] Rebuilding incomplete dimension ${manifestDimensionKey(dimension)} because output files are missing or unreadable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return completed;
}

function manifestDimensionKey(dimension: Pick<RangeDimension, "strategy" | "playerCount" | "depthBb">): string {
  return `${dimension.strategy}:${dimension.playerCount}:${dimension.depthBb}`;
}
