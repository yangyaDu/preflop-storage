import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBinFileName, type RangeDimension } from "../src/db/naming";
import { getIdxFileName } from "../src/range-strata-binary/catalog/naming";
import { cleanupPreviousOutput } from "../src/range-strata-binary/compiler/cleanup";
import type { BuildManifest } from "../src/range-strata-binary/compiler/types";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("cleanupPreviousOutput", () => {
  test("removes known Range Strata Binary output files and leaves unrelated files", async () => {
    const { outDir } = await makeTempOutput("preflop-storage-cleanup-known-");
    const dimension = makeDimension(100);
    const metaDbPath = join(outDir, "meta.db");
    const buildManifestPath = join(outDir, "manifest.json");
    const manifestFile = "extra-report.json";
    const unrelatedFile = join(outDir, "notes.txt");

    await writeFiles([
      metaDbPath,
      `${metaDbPath}-wal`,
      `${metaDbPath}-shm`,
      buildManifestPath,
      join(outDir, manifestFile),
      join(outDir, dimension.binFile),
      `${join(outDir, dimension.binFile)}.tmp`,
      join(outDir, getIdxFileName(dimension.strategy, dimension.playerCount, dimension.depthBb)),
      `${join(outDir, getIdxFileName(dimension.strategy, dimension.playerCount, dimension.depthBb))}.tmp`,
      unrelatedFile,
    ]);

    await cleanupPreviousOutput({
      rangeStrataStoreDir: outDir,
      metaDbPath,
      buildManifestPath,
      previousBuildManifest: makeManifest([manifestFile]),
      targetRangeDimensions: [dimension],
    });

    expect(existsSync(metaDbPath)).toBe(false);
    expect(existsSync(`${metaDbPath}-wal`)).toBe(false);
    expect(existsSync(`${metaDbPath}-shm`)).toBe(false);
    expect(existsSync(buildManifestPath)).toBe(false);
    expect(existsSync(join(outDir, manifestFile))).toBe(false);
    expect(existsSync(join(outDir, dimension.binFile))).toBe(false);
    expect(existsSync(`${join(outDir, dimension.binFile)}.tmp`)).toBe(false);
    expect(existsSync(join(outDir, getIdxFileName(dimension.strategy, dimension.playerCount, dimension.depthBb)))).toBe(false);
    expect(existsSync(`${join(outDir, getIdxFileName(dimension.strategy, dimension.playerCount, dimension.depthBb))}.tmp`)).toBe(false);
    expect(existsSync(unrelatedFile)).toBe(true);
  });

  test("ignores manifest and dimension paths that escape the output directory", async () => {
    const { rootDir, outDir } = await makeTempOutput("preflop-storage-cleanup-safe-path-");
    const outsideManifestFile = join(rootDir, "outside-manifest.bin");
    const outsideDimensionFile = join(rootDir, "outside-dimension.bin");
    const absoluteOutsideFile = join(rootDir, "absolute-outside.bin");

    await writeFiles([outsideManifestFile, outsideDimensionFile, absoluteOutsideFile]);

    await cleanupPreviousOutput({
      rangeStrataStoreDir: outDir,
      metaDbPath: join(outDir, "meta.db"),
      buildManifestPath: join(outDir, "manifest.json"),
      previousBuildManifest: makeManifest(["../outside-manifest.bin", absoluteOutsideFile]),
      targetRangeDimensions: [
        {
          ...makeDimension(100),
          binFile: "../outside-dimension.bin",
        },
      ],
    });

    expect(existsSync(outsideManifestFile)).toBe(true);
    expect(existsSync(outsideDimensionFile)).toBe(true);
    expect(existsSync(absoluteOutsideFile)).toBe(true);
  });
});

async function makeTempOutput(prefix: string): Promise<{ rootDir: string; outDir: string }> {
  const rootDir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(rootDir);
  const outDir = join(rootDir, "out");
  await mkdir(outDir, { recursive: true });
  return { rootDir, outDir };
}

function makeDimension(depthBb: number): RangeDimension {
  return {
    strategy: "default",
    playerCount: 6,
    depthBb,
    rangeTable: `range_data_default_6max_${depthBb}BB`,
    concreteTable: `concrete_lines_default_6max_${depthBb}BB`,
    binFile: getBinFileName("default", 6, depthBb),
  };
}

function makeManifest(files: string[]): BuildManifest {
  return {
    format: "PFSP",
    version: 1,
    sourceDbChecksum: "source-checksum",
    builtAt: "2026-01-01T00:00:00.000Z",
    dimensions: [],
    files,
  };
}

async function writeFiles(paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => Bun.write(path, "x")));
}
