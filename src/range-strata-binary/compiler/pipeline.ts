import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RangeDimension } from "../../db/naming";
import { discoverRangeDimensions } from "../../importer/old-sqlite";
import { filterDimensions } from "../../utils/dimension";
import { initLightMetaDb } from "../catalog/schema";
import { formatBuildManifestIssues, parseBuildManifestJson } from "./manifest";
import { resolveBuildPlan } from "./plan";
import type { BuildRangeStrataBinaryStoreOptions, BuildManifest, BuildReport, DimensionBuildStats } from "./types";
import { cleanupPreviousOutput } from "./cleanup";
import { writeManifestAndReport } from "./build-report";
import { copyConcreteLines, copyDrillScenarioLines } from "./build-metadata";
import { finalizeBuildStatements, prepareBuildStatements, type BuildStatements } from "./build-statements";
import { buildDimensionWithStats } from "./dimension-builder";

export type {
  BuildRangeStrataBinaryStoreOptions,
  BuildManifest,
  BuildManifestDimension,
  BuildManifestDimensionStatus,
  BuildReport,
  DimensionBuildStats,
} from "./types";

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
  } catch (error) {
    warnRecoverable("Could not stat source DB; report source size will be 0", error);
  }

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
    const parsed = parseBuildManifestJson(await Bun.file(buildManifestPath).text());
    if (!parsed.manifest) {
      console.warn(`[build] Ignoring invalid manifest at ${buildManifestPath}: ${formatBuildManifestIssues(parsed.issues)}`);
      return null;
    }
    return parsed.manifest;
  } catch (error) {
    warnRecoverable(`Could not read manifest at ${buildManifestPath}`, error);
    return null;
  }
}

async function computeFileSha256(filePath: string): Promise<string> {
  try {
    const bytes = await Bun.file(filePath).bytes();
    return createHash("sha256").update(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)).digest("hex");
  } catch (error) {
    warnRecoverable(`Could not compute sha256 for ${filePath}; checksum will be recorded as unknown`, error);
    return "unknown";
  }
}

function warnRecoverable(message: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.warn(`[build] ${message}: ${detail}`);
}
