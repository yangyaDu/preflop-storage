import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { getBinFileName, type RangeDimension } from "../../db/naming";
import { PreflopStoreError } from "../../query/errors";
import { getIdxFileName } from "../db/naming";
import type { BuildManifest, DimensionBuildStats } from "./build-types";

interface ResolveBuildPlanOptions {
  outDir: string;
  overwrite?: boolean;
  resume?: boolean;
}

export type BuildPlanMode = "fresh" | "resume" | "overwrite";

export interface BuildPlan {
  mode: BuildPlanMode;
  shouldCleanupOutput: boolean;
  previousCompletedStats: DimensionBuildStats[];
  dimensionsToBuild: RangeDimension[];
}

export async function resolveBuildPlan(params: {
  options: ResolveBuildPlanOptions;
  metaPath: string;
  previousManifest: BuildManifest | null;
  sourceDbChecksum: string;
  allDimensions: RangeDimension[];
}): Promise<BuildPlan> {
  const { options, metaPath, previousManifest, sourceDbChecksum, allDimensions } = params;
  const metaExists = existsSync(metaPath);

  if (metaExists && !options.overwrite) {
    if (options.resume && previousManifest) {
      // Resume mode can continue with the existing meta.db.
    } else if (options.resume) {
      throw new PreflopStoreError("BUILD_ERROR", "meta.db exists but manifest.json is missing or unreadable. Pass --overwrite to rebuild from scratch.", { metaPath });
    } else {
      throw new PreflopStoreError("BUILD_ERROR", `Output meta DB already exists: ${metaPath}. Pass --overwrite to rebuild it or --resume to continue.`, { metaPath });
    }
  }

  if (options.resume && previousManifest && !options.overwrite) {
    assertResumeSourceChecksum(previousManifest, sourceDbChecksum);
  }

  const isFreshBuild = Boolean(options.overwrite) || !metaExists;
  const mode: BuildPlanMode = options.overwrite ? "overwrite" : options.resume && !isFreshBuild ? "resume" : "fresh";
  const knownDimensionKeys = new Set(allDimensions.map((dimension) => manifestDimensionKey(dimension)));
  const previousCompletedStats = mode === "resume" && previousManifest
    ? await collectCompletedManifestStats(previousManifest, options.outDir, knownDimensionKeys)
    : [];
  const completedDimKeys = new Set(previousCompletedStats.map((dimension) => manifestDimensionKey(dimension)));
  const dimensionsToBuild = mode === "resume"
    ? allDimensions.filter((dimension) => !completedDimKeys.has(manifestDimensionKey(dimension)))
    : allDimensions;

  return {
    mode,
    shouldCleanupOutput: mode !== "resume",
    previousCompletedStats,
    dimensionsToBuild,
  };
}

function assertResumeSourceChecksum(previousManifest: BuildManifest, sourceDbChecksum: string): void {
  const previousChecksum = previousManifest.sourceDbChecksum;
  if (!previousChecksum || previousChecksum === "unknown" || sourceDbChecksum === "unknown") {
    return;
  }

  if (previousChecksum !== sourceDbChecksum) {
    throw new PreflopStoreError(
      "BUILD_ERROR",
      "Source DB checksum differs from manifest.json. Refusing --resume because completed dimensions may be stale. Pass --overwrite to rebuild from scratch.",
      {
        manifestChecksum: previousChecksum,
        sourceDbChecksum,
      },
    );
  }
}

async function collectCompletedManifestStats(
  manifest: BuildManifest,
  outDir: string,
  knownDimensionKeys: Set<string>,
): Promise<DimensionBuildStats[]> {
  const completed: DimensionBuildStats[] = [];

  for (const dimension of manifest.dimensions) {
    if (dimension.status !== "success") continue;
    if (!knownDimensionKeys.has(manifestDimensionKey(dimension))) continue;

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
