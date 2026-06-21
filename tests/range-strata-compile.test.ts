import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { buildRangeStrataBinaryStore } from "../src/range-strata-binary/compiler/pipeline";
import { RangeStrataQueryService } from "../src/range-strata-binary/query/service";
import { decodeFileHeader, assertSupportedHeader, RANGE_FILE_HEADER_SIZE } from "../src/binary/file-header";
import { decodeIdxHeader, assertIdxHeader } from "../src/range-strata-binary/index/types";
import { PreflopQueryError } from "../src/query/errors";
import {
  createBuiltRangeDbFixture,
  createRangeDbFixtureInRoot,
  type RangeDimensionFixture,
} from "./helpers/range-db-fixture";
import { createTempDirRegistry } from "./helpers/temp-dir";

const tempDirs = createTempDirRegistry();

afterEach(tempDirs.cleanup);

describe("Range Strata Binary build pipeline", () => {
  test("produces meta.db, .bin, and .idx files", async () => {
    const { outDir } = await buildFixture();
    expect(existsSync(join(outDir, "meta.db"))).toBe(true);
    expect(existsSync(join(outDir, "ranges_default_6max_100BB.bin"))).toBe(true);
    expect(existsSync(join(outDir, "ranges_default_6max_100BB.idx"))).toBe(true);
  });

  test("built .bin has valid PFSP header", async () => {
    const { outDir } = await buildFixture();
    const binPath = join(outDir, "ranges_default_6max_100BB.bin");
    const bytes = await Bun.file(binPath).bytes();
    const header = decodeFileHeader(bytes.subarray(0, RANGE_FILE_HEADER_SIZE));
    assertSupportedHeader(header);
    expect(header.magic).toBe("PFSP");
    expect(header.version).toBe(1);
  });

  test("built .idx has valid PFXI header", async () => {
    const { outDir } = await buildFixture();
    const idxPath = join(outDir, "ranges_default_6max_100BB.idx");
    const bytes = await Bun.file(idxPath).bytes();
    const header = decodeIdxHeader(bytes.subarray(0, 16));
    assertIdxHeader(header);
    expect(header.recordCount).toBe(2);
  });

  test("built .bin CRC32C checksums are valid", async () => {
    const { outDir } = await buildFixture();
    const service = new RangeStrataQueryService(join(outDir, "meta.db"), outDir, {
      verifyChecksums: true,
    });

    try {
      service.prewarmDimension({ playerCount: 6, depthBb: 100 });
      // Query should not throw on valid CRC
      const strategy = service.getHandStrategySync({
        playerCount: 6,
        depthBb: 100,
        concreteLineId: 1,
        holeCards: "AA",
      });
      expect(strategy).not.toBeNull();
    } finally {
      service.close();
    }
  });

  test("corrupted .bin throws CHECKSUM_MISMATCH when checksums are enabled", async () => {
    const { outDir } = await buildFixture();
    const binPath = join(outDir, "ranges_default_6max_100BB.bin");
    await mutateFile(binPath, (bytes) => {
      bytes[RANGE_FILE_HEADER_SIZE] ^= 0xff;
    });

    const service = new RangeStrataQueryService(join(outDir, "meta.db"), outDir, {
      verifyChecksums: true,
    });

    try {
      service.prewarmDimension({ playerCount: 6, depthBb: 100 });
      expectSyncQueryErrorCode(
        () =>
          service.getHandStrategySync({
            playerCount: 6,
            depthBb: 100,
            concreteLineId: 1,
            holeCards: "AA",
          }),
        "CHECKSUM_MISMATCH",
      );
    } finally {
      service.close();
    }
  });

  test("batch query reports checksum failures without masking invalid hands", async () => {
    const { outDir } = await buildFixture();
    const binPath = join(outDir, "ranges_default_6max_100BB.bin");
    await mutateFile(binPath, (bytes) => {
      bytes[RANGE_FILE_HEADER_SIZE] ^= 0xff;
    });

    const service = new RangeStrataQueryService(join(outDir, "meta.db"), outDir, {
      verifyChecksums: true,
    });

    try {
      service.prewarmDimension({ playerCount: 6, depthBb: 100 });
      const batch = service.getHandStrategiesBatchSync({
        playerCount: 6,
        depthBb: 100,
        requests: [
          { concreteLineId: 1, holeCards: "AA" },
          { concreteLineId: 1, holeCards: "XX" },
        ],
      });

      expect(batch[0].strategy).toBeNull();
      expect(batch[0].error?.code).toBe("CHECKSUM_MISMATCH");
      expect(batch[1].strategy).toBeNull();
      expect(batch[1].error?.code).toBe("UNKNOWN_HAND");
    } finally {
      service.close();
    }
  });

  test("corrupted .idx pack range throws INVALID_FORMAT instead of panicking", async () => {
    const { outDir } = await buildFixture();
    const idxPath = join(outDir, "ranges_default_6max_100BB.idx");
    await mutateFile(idxPath, (bytes) => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      view.setUint32(16 + 10, RANGE_FILE_HEADER_SIZE - 1, true);
    });

    const service = new RangeStrataQueryService(join(outDir, "meta.db"), outDir, {
      verifyChecksums: true,
    });

    try {
      service.prewarmDimension({ playerCount: 6, depthBb: 100 });
      expectSyncQueryErrorCode(
        () =>
          service.getHandStrategySync({
            playerCount: 6,
            depthBb: 100,
            concreteLineId: 1,
            holeCards: "AA",
          }),
        "INVALID_FORMAT",
      );
    } finally {
      service.close();
    }
  });

  test("async cold query preserves BIN_FILE_NOT_FOUND for missing binary files", async () => {
    const { outDir } = await buildFixture();
    await rm(join(outDir, "ranges_default_6max_100BB.bin"), { force: true });
    const service = new RangeStrataQueryService(join(outDir, "meta.db"), outDir);

    try {
      let caught: unknown;
      try {
        await service.getHandStrategy({
          playerCount: 6,
          depthBb: 100,
          concreteLineId: 1,
          holeCards: "AA",
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(PreflopQueryError);
      expect((caught as PreflopQueryError).code).toBe("BIN_FILE_NOT_FOUND");
    } finally {
      service.close();
    }
  });

  test("built store queries return correct strategy data", async () => {
    const { outDir } = await buildFixture();
    const service = new RangeStrataQueryService(join(outDir, "meta.db"), outDir);

    try {
      service.prewarmDimension({ playerCount: 6, depthBb: 100 });
      // Query AA on concrete line 1
      const strategy = service.getHandStrategySync({
        playerCount: 6,
        depthBb: 100,
        concreteLineId: 1,
        holeCards: "AA",
      });

      if (!strategy) {
        expect(strategy).not.toBeNull();
        return;
      }

      expect(strategy.holeCards).toBe("AA");
      expect(strategy.exists).toBe(true);
      expect(strategy.actions.length).toBeGreaterThan(0);

      // Verify action names expected from the fixture
      const actionNames = strategy.actions.map((a) => a.actionName).sort();
      expect(actionNames).toContain("fold");
      expect(actionNames).toContain("call");
      expect(actionNames).toContain("raise");
    } finally {
      service.close();
    }
  });

  test("batch query returns correct results", async () => {
    const { outDir } = await buildFixture();
    const service = new RangeStrataQueryService(join(outDir, "meta.db"), outDir);

    try {
      service.prewarmDimension({ playerCount: 6, depthBb: 100 });
      const batch = service.getHandStrategiesBatchSync({
        playerCount: 6,
        depthBb: 100,
        requests: [
          { concreteLineId: 1, holeCards: "AA" },
          { concreteLineId: 2, holeCards: "A3o" },
        ],
      });

      expect(batch.length).toBe(2);
      expect(batch[0].strategy).not.toBeNull();
      expect(batch[0].error).toBeNull();
      expect(batch[1].strategy).not.toBeNull();
      expect(batch[1].error).toBeNull();
    } finally {
      service.close();
    }
  });

  test("hand not in pack returns null strategy", async () => {
    const { outDir } = await buildFixture();
    const service = new RangeStrataQueryService(join(outDir, "meta.db"), outDir);

    try {
      service.prewarmDimension({ playerCount: 6, depthBb: 100 });
      const strategy = service.getHandStrategySync({
        playerCount: 6,
        depthBb: 100,
        concreteLineId: 1,
        holeCards: "72o",
      });
      expect(strategy).toBeNull();
    } finally {
      service.close();
    }
  });

  test("unknown hand throws UNKNOWN_HAND error", async () => {
    const { outDir } = await buildFixture();
    const service = new RangeStrataQueryService(join(outDir, "meta.db"), outDir);

    try {
      service.prewarmDimension({ playerCount: 6, depthBb: 100 });
      const batch = service.getHandStrategiesBatchSync({
        playerCount: 6,
        depthBb: 100,
        requests: [
          { concreteLineId: 1, holeCards: "XX" },
        ],
      });

      expect(batch[0].strategy).toBeNull();
      expect(batch[0].error).not.toBeNull();
      expect(batch[0].error!.code).toBe("UNKNOWN_HAND");
    } finally {
      service.close();
    }
  });

  test("build without overwrite rejects when meta.db already exists", async () => {
    const rootDir = await tempDirs.make("preflop-storage-range-strata-binary-build-overwrite-");
    const { sourcePath, outDir } = await createRangeDbFixtureInRoot(rootDir, {
      dimensions: [{ playerCount: 6, depthBb: 100, concreteLines: [], rangeRows: [] }],
    });
    await mkdir(outDir, { recursive: true });
    // Create a valid SQLite meta.db to simulate pre-existing output
    const dummyDb = new Database(join(outDir, "meta.db"));
    dummyDb.exec("CREATE TABLE build_info(key TEXT PRIMARY KEY, value TEXT)");
    dummyDb.close();

    await expect(
      buildRangeStrataBinaryStore({ sourceDbPath: sourcePath, outDir, overwrite: false }),
    ).rejects.toThrow("Output meta DB already exists");
  });

  test("multi-dimensional build produces correct files", async () => {
    const rootDir = await tempDirs.make("preflop-storage-range-strata-binary-build-");

    const { sourcePath, outDir } = await createTwoDimensionSource(rootDir);

    await buildRangeStrataBinaryStore({ sourceDbPath: sourcePath, outDir, overwrite: true });

    expect(existsSync(join(outDir, "ranges_default_6max_100BB.bin"))).toBe(true);
    expect(existsSync(join(outDir, "ranges_default_6max_200BB.bin"))).toBe(true);
  });

  test("resume skips successful dimensions and rebuilds failed dimensions", async () => {
    const rootDir = await tempDirs.make("preflop-storage-range-strata-binary-resume-");

    const { sourcePath, outDir } = await createTwoDimensionSource(rootDir);
    const firstReport = await buildRangeStrataBinaryStore({ sourceDbPath: sourcePath, outDir, overwrite: true });

    expect(firstReport.totals.errorCount).toBe(0);
    let manifest = JSON.parse(await Bun.file(join(outDir, "manifest.json")).text()) as {
      dimensions: Array<{ depthBb: number; status: string; error: string | null }>;
    };
    expect(manifest.dimensions.find((dimension) => dimension.depthBb === 100)?.status).toBe("success");
    const failedDimension = manifest.dimensions.find((dimension) => dimension.depthBb === 200);
    if (!failedDimension) {
      expect(failedDimension).toBeDefined();
      return;
    }
    failedDimension.status = "failed";
    failedDimension.error = "synthetic interrupted build";
    await Bun.write(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    await rm(join(outDir, "ranges_default_6max_200BB.bin"), { force: true });
    await rm(join(outDir, "ranges_default_6max_200BB.idx"), { force: true });

    const resumeReport = await buildRangeStrataBinaryStore({ sourceDbPath: sourcePath, outDir, resume: true });
    const skippedDimension = resumeReport.dimensions.find((dimension) => dimension.depthBb === 100);
    const rebuiltDimension = resumeReport.dimensions.find((dimension) => dimension.depthBb === 200);

    expect(resumeReport.totals.errorCount).toBe(0);
    expect(skippedDimension?.srcRowCount).toBe(0);
    expect(skippedDimension?.durationMs).toBe(0);
    expect(rebuiltDimension?.srcRowCount).toBe(1);

    manifest = JSON.parse(await Bun.file(join(outDir, "manifest.json")).text()) as {
      dimensions: Array<{ depthBb: number; status: string; error: string | null }>;
    };
    expect(manifest.dimensions.every((dimension) => dimension.status === "success")).toBe(true);
  });

  test("resume rejects when source DB checksum changed", async () => {
    const rootDir = await tempDirs.make("preflop-storage-range-strata-binary-resume-checksum-");

    const { sourcePath, outDir } = await createTwoDimensionSource(rootDir);
    await buildRangeStrataBinaryStore({ sourceDbPath: sourcePath, outDir, overwrite: true });

    const db = new Database(sourcePath);
    try {
      db.query("UPDATE range_data_default_6max_100BB SET frequency = 0.5 WHERE concrete_line_id = 1").run();
    } finally {
      db.close();
    }

    await expect(
      buildRangeStrataBinaryStore({ sourceDbPath: sourcePath, outDir, resume: true }),
    ).rejects.toThrow("Source DB checksum differs");
  });

  test("overwrite removes files listed by the previous manifest", async () => {
    const rootDir = await tempDirs.make("preflop-storage-range-strata-binary-overwrite-clean-");

    const { sourcePath, outDir } = await createTwoDimensionSource(rootDir);
    await buildRangeStrataBinaryStore({ sourceDbPath: sourcePath, outDir, overwrite: true });

    const removedBinPath = join(outDir, "ranges_default_6max_200BB.bin");
    const removedIdxPath = join(outDir, "ranges_default_6max_200BB.idx");
    expect(existsSync(removedBinPath)).toBe(true);
    expect(existsSync(removedIdxPath)).toBe(true);

    const db = new Database(sourcePath);
    try {
      db.exec(`
        DROP TABLE range_data_default_6max_200BB;
        DROP TABLE concrete_lines_default_6max_200BB;
      `);
    } finally {
      db.close();
    }

    await buildRangeStrataBinaryStore({ sourceDbPath: sourcePath, outDir, overwrite: true });

    expect(existsSync(removedBinPath)).toBe(false);
    expect(existsSync(removedIdxPath)).toBe(false);
  }, 15000);

  test("writes JSON and Markdown build stats", async () => {
    const { outDir, sourcePath } = await buildFixture();
    const statsOutPath = join(outDir, "reports", "build.json");
    const statsMdPath = join(outDir, "reports", "build.md");

    await buildRangeStrataBinaryStore({
      sourceDbPath: sourcePath,
      outDir,
      overwrite: true,
      statsOutPath,
      statsMdPath,
    });

    const statsJson = JSON.parse(await Bun.file(statsOutPath).text()) as {
      totals: { dimensionCount: number; errorCount: number };
    };
    const statsMarkdown = await Bun.file(statsMdPath).text();

    expect(statsJson.totals.dimensionCount).toBe(1);
    expect(statsJson.totals.errorCount).toBe(0);
    expect(statsMarkdown).toContain("# Range Strata Binary Build Report");
  });
});

async function createTwoDimensionSource(
  rootDir: string,
  options: { secondActionName?: string } = {},
): Promise<{ sourcePath: string; outDir: string }> {
  const secondActionName = options.secondActionName ?? "raise";
  const { sourcePath, outDir } = await createRangeDbFixtureInRoot(rootDir, {
    dimensions: [
      {
        playerCount: 6,
        depthBb: 100,
        concreteLines: [{ id: 1, abstractLine: "R-C", concreteLine: "R2-C" }],
        rangeRows: [
          { concreteLineId: 1, holeCards: "AA", actionName: "fold", actionSize: 0, amountBb: 0, frequency: 1, handEv: 0 },
        ],
      },
      {
        playerCount: 6,
        depthBb: 200,
        concreteLines: [{ id: 1, abstractLine: "R-C", concreteLine: "R2-C" }],
        rangeRows: [
          {
            concreteLineId: 1,
            holeCards: "KK",
            actionName: secondActionName,
            actionSize: 40,
            amountBb: 2,
            frequency: 1,
            handEv: 10,
          },
        ],
      },
    ],
  });
  return { sourcePath, outDir };
}

async function buildFixture(): Promise<{ outDir: string; sourcePath: string }> {
  return createBuiltRangeDbFixture({
    tempDirs,
    prefix: "preflop-storage-range-strata-binary-build-",
    spec: { dimensions: [compileDimension] },
  });
}

async function mutateFile(path: string, mutate: (bytes: Uint8Array) => void): Promise<void> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  mutate(bytes);
  await Bun.write(path, bytes);
}

function expectSyncQueryErrorCode(fn: () => unknown, code: PreflopQueryError["code"]): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(PreflopQueryError);
  expect((caught as PreflopQueryError).code).toBe(code);
}

const compileDimension: RangeDimensionFixture = {
  playerCount: 6,
  depthBb: 100,
  concreteLines: [
    { id: 1, abstractLine: "R-C", concreteLine: "R2-C" },
    { id: 2, abstractLine: "R-C", concreteLine: "R3.5-C" },
  ],
  rangeRows: [
    { concreteLineId: 1, holeCards: "AA", actionName: "fold", actionSize: 0, amountBb: 0, frequency: 0.1, handEv: 0 },
    { concreteLineId: 1, holeCards: "AA", actionName: "call", actionSize: 0, amountBb: 0, frequency: 0.2, handEv: 1 },
    { concreteLineId: 1, holeCards: "AA", actionName: "raise", actionSize: 40, amountBb: 2, frequency: 0.7, handEv: 2 },
    { concreteLineId: 2, holeCards: "A3o", actionName: "fold", actionSize: 0, amountBb: 0, frequency: 0.6, handEv: 0 },
    { concreteLineId: 2, holeCards: "A3o", actionName: "call", actionSize: 0, amountBb: 0, frequency: 0.4, handEv: -1 },
    { concreteLineId: 2, holeCards: "A3o", actionName: "raise", actionSize: 40, amountBb: 2, frequency: 0, handEv: -2 },
  ],
};
