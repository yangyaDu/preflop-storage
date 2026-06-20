import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBinFileName, type RangeDimension } from "../src/db/naming";
import { getIdxFileName } from "../src/scheme2/db/naming";
import { cleanupPreviousOutput } from "../src/scheme2/importer/cleanup-output";
import type { BuildManifest } from "../src/scheme2/importer/build-types";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("cleanupPreviousOutput", () => {
  test("removes known Scheme2 output files and leaves unrelated files", async () => {
    const { outDir } = await makeTempOutput("preflop-storage-cleanup-known-");
    const dimension = makeDimension(100);
    const metaPath = join(outDir, "meta.db");
    const manifestPath = join(outDir, "manifest.json");
    const manifestFile = "extra-report.json";
    const unrelatedFile = join(outDir, "notes.txt");

    await writeFiles([
      metaPath,
      `${metaPath}-wal`,
      `${metaPath}-shm`,
      manifestPath,
      join(outDir, manifestFile),
      join(outDir, dimension.binFile),
      `${join(outDir, dimension.binFile)}.tmp`,
      join(outDir, getIdxFileName(dimension.strategy, dimension.playerCount, dimension.depthBb)),
      `${join(outDir, getIdxFileName(dimension.strategy, dimension.playerCount, dimension.depthBb))}.tmp`,
      unrelatedFile,
    ]);

    await cleanupPreviousOutput({
      outDir,
      metaPath,
      manifestPath,
      manifest: makeManifest([manifestFile]),
      dimensions: [dimension],
    });

    expect(existsSync(metaPath)).toBe(false);
    expect(existsSync(`${metaPath}-wal`)).toBe(false);
    expect(existsSync(`${metaPath}-shm`)).toBe(false);
    expect(existsSync(manifestPath)).toBe(false);
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
      outDir,
      metaPath: join(outDir, "meta.db"),
      manifestPath: join(outDir, "manifest.json"),
      manifest: makeManifest(["../outside-manifest.bin", absoluteOutsideFile]),
      dimensions: [
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
