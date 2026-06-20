import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBinFileName, type RangeDimension } from "../src/db/naming";
import { getIdxFileName } from "../src/scheme2/db/naming";
import { resolveBuildPlan } from "../src/scheme2/importer/build-plan";
import type { BuildManifest, BuildManifestDimension, BuildManifestDimensionStatus } from "../src/scheme2/importer/build-types";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("resolveBuildPlan", () => {
  test("plans a fresh build when meta.db does not exist", async () => {
    const outDir = await makeTempDir("preflop-storage-build-plan-fresh-");
    const dimensions = [makeDimension(100), makeDimension(200)];

    const plan = await resolveBuildPlan({
      options: { outDir },
      metaPath: join(outDir, "meta.db"),
      previousManifest: null,
      sourceDbChecksum: "source-checksum",
      allDimensions: dimensions,
    });

    expect(plan.mode).toBe("fresh");
    expect(plan.shouldCleanupOutput).toBe(true);
    expect(plan.previousCompletedStats).toEqual([]);
    expect(depths(plan.dimensionsToBuild)).toEqual([100, 200]);
  });

  test("rejects existing meta.db without resume or overwrite", async () => {
    const outDir = await makeTempDir("preflop-storage-build-plan-existing-meta-");
    await Bun.write(join(outDir, "meta.db"), "");

    await expect(
      resolveBuildPlan({
        options: { outDir },
        metaPath: join(outDir, "meta.db"),
        previousManifest: null,
        sourceDbChecksum: "source-checksum",
        allDimensions: [makeDimension(100)],
      }),
    ).rejects.toThrow("Output meta DB already exists");
  });

  test("rejects resume when meta.db exists but manifest is missing", async () => {
    const outDir = await makeTempDir("preflop-storage-build-plan-missing-manifest-");
    await Bun.write(join(outDir, "meta.db"), "");

    await expect(
      resolveBuildPlan({
        options: { outDir, resume: true },
        metaPath: join(outDir, "meta.db"),
        previousManifest: null,
        sourceDbChecksum: "source-checksum",
        allDimensions: [makeDimension(100)],
      }),
    ).rejects.toThrow("manifest.json is missing or unreadable");
  });

  test("rejects resume when the source checksum changed", async () => {
    const outDir = await makeTempDir("preflop-storage-build-plan-checksum-");
    const dimension = makeDimension(100);
    await Bun.write(join(outDir, "meta.db"), "");
    await writeCompletedFiles(outDir, dimension);

    await expect(
      resolveBuildPlan({
        options: { outDir, resume: true },
        metaPath: join(outDir, "meta.db"),
        previousManifest: makeManifest([makeManifestDimension(dimension)]),
        sourceDbChecksum: "changed-checksum",
        allDimensions: [dimension],
      }),
    ).rejects.toThrow("Source DB checksum differs");
  });

  test("resume skips only known successful dimensions and rebuilds failed ones", async () => {
    const outDir = await makeTempDir("preflop-storage-build-plan-resume-");
    const completed = makeDimension(100);
    const failed = makeDimension(200);
    const unknown = makeDimension(300, "legacy");

    await Bun.write(join(outDir, "meta.db"), "");
    await writeCompletedFiles(outDir, completed);
    await writeCompletedFiles(outDir, failed);
    await writeCompletedFiles(outDir, unknown);

    const plan = await resolveBuildPlan({
      options: { outDir, resume: true },
      metaPath: join(outDir, "meta.db"),
      previousManifest: makeManifest([
        makeManifestDimension(completed),
        makeManifestDimension(failed, "failed"),
        makeManifestDimension(unknown),
      ]),
      sourceDbChecksum: "source-checksum",
      allDimensions: [completed, failed],
    });

    expect(plan.mode).toBe("resume");
    expect(plan.shouldCleanupOutput).toBe(false);
    expect(depths(plan.previousCompletedStats)).toEqual([100]);
    expect(depths(plan.dimensionsToBuild)).toEqual([200]);
  });

  test("does not skip a successful manifest dimension when its file sizes changed", async () => {
    const outDir = await makeTempDir("preflop-storage-build-plan-size-mismatch-");
    const dimension = makeDimension(100);

    await Bun.write(join(outDir, "meta.db"), "");
    await writeCompletedFiles(outDir, dimension);

    const plan = await resolveBuildPlan({
      options: { outDir, resume: true },
      metaPath: join(outDir, "meta.db"),
      previousManifest: makeManifest([
        makeManifestDimension(dimension, "success", { binFileSizeBytes: 999, idxFileSizeBytes: 2 }),
      ]),
      sourceDbChecksum: "source-checksum",
      allDimensions: [dimension],
    });

    expect(plan.previousCompletedStats).toEqual([]);
    expect(depths(plan.dimensionsToBuild)).toEqual([100]);
  });

  test("overwrite ignores stale manifest state and requests cleanup", async () => {
    const outDir = await makeTempDir("preflop-storage-build-plan-overwrite-");
    const dimensions = [makeDimension(100), makeDimension(200)];
    await Bun.write(join(outDir, "meta.db"), "");

    const plan = await resolveBuildPlan({
      options: { outDir, overwrite: true, resume: true },
      metaPath: join(outDir, "meta.db"),
      previousManifest: makeManifest([makeManifestDimension(dimensions[0])], "old-checksum"),
      sourceDbChecksum: "new-checksum",
      allDimensions: dimensions,
    });

    expect(plan.mode).toBe("overwrite");
    expect(plan.shouldCleanupOutput).toBe(true);
    expect(plan.previousCompletedStats).toEqual([]);
    expect(depths(plan.dimensionsToBuild)).toEqual([100, 200]);
  });
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

function makeDimension(depthBb: number, strategy = "default"): RangeDimension {
  return {
    strategy,
    playerCount: 6,
    depthBb,
    rangeTable: `range_data_${strategy}_6max_${depthBb}BB`,
    concreteTable: `concrete_lines_${strategy}_6max_${depthBb}BB`,
    binFile: getBinFileName(strategy, 6, depthBb),
  };
}

function makeManifest(
  dimensions: BuildManifestDimension[],
  sourceDbChecksum = "source-checksum",
): BuildManifest {
  return {
    format: "PFSP",
    version: 1,
    sourceDbChecksum,
    builtAt: "2026-01-01T00:00:00.000Z",
    dimensions,
    files: ["meta.db"],
  };
}

function makeManifestDimension(
  dimension: RangeDimension,
  status: BuildManifestDimensionStatus = "success",
  sizes: Partial<Pick<BuildManifestDimension, "binFileSizeBytes" | "idxFileSizeBytes">> = {},
): BuildManifestDimension {
  return {
    strategy: dimension.strategy,
    playerCount: dimension.playerCount,
    depthBb: dimension.depthBb,
    concreteLineCount: 2,
    packCount: 2,
    status,
    error: status === "failed" ? "failed during build" : null,
    binFile: dimension.binFile,
    idxFile: getIdxFileName(dimension.strategy, dimension.playerCount, dimension.depthBb),
    ...sizes,
  };
}

async function writeCompletedFiles(outDir: string, dimension: RangeDimension): Promise<void> {
  await Bun.write(join(outDir, dimension.binFile), new Uint8Array([1, 2, 3, 4]));
  await Bun.write(
    join(outDir, getIdxFileName(dimension.strategy, dimension.playerCount, dimension.depthBb)),
    new Uint8Array([5, 6]),
  );
}

function depths(dimensions: Array<Pick<RangeDimension, "depthBb">>): number[] {
  return dimensions.map((dimension) => dimension.depthBb);
}
