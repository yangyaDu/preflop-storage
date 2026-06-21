import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRangeStrataBinaryStore } from "../src/range-strata-binary/compiler/pipeline";
import { RangeStrataQueryService } from "../src/range-strata-binary/query/service";
import { PreflopQueryError } from "../src/query/errors";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await removeTempDirWithRetry(dir).catch(() => {});
  }
});

describe("RangeStrataQueryService", () => {
  test("fresh range-strata-binary build preserves concrete line metadata", async () => {
    const { outDir } = await buildFixture();
    const service = new RangeStrataQueryService(join(outDir, "meta.db"), outDir);

    try {
      const lines = service.getConcreteLines({
        playerCount: 6,
        depthBb: 100,
        abstractLine: "R-C",
      });

      expect(lines).toEqual([
        { concrete_line_id: 1, abstract_line: "R-C", concrete_line: "R2-C" },
        { concrete_line_id: 2, abstract_line: "R-C", concrete_line: "R3.5-C" },
      ]);
    } finally {
      service.close();
    }
  });

  test("getHandsByAction works when AA is not present in a sparse pack", async () => {
    const { outDir } = await buildFixture();
    const service = new RangeStrataQueryService(join(outDir, "meta.db"), outDir);

    try {
      const callHands = await service.getHandsByAction({
        playerCount: 6,
        depthBb: 100,
        concreteLineId: 2,
        actionNames: ["call"],
      });
      const strongCallHands = await service.getHandsByAction({
        playerCount: 6,
        depthBb: 100,
        concreteLineId: 2,
        actionNames: ["call"],
        minFrequency: 0.2,
      });

      expect(callHands).toEqual(["A3o"]);
      expect(strongCallHands).toEqual(["A3o"]);
    } finally {
      service.close();
    }
  });

  test("prewarmActionSchemas fills cache once", async () => {
    const { outDir } = await buildFixture();
    const service = new RangeStrataQueryService(join(outDir, "meta.db"), outDir);

    try {
      expect(service.prewarmActionSchemas()).toBeGreaterThan(0);
      expect(service.prewarmActionSchemas()).toBe(0);
    } finally {
      service.close();
    }
  });

  test("empty batch requests return empty results without opening a dimension", async () => {
    const { outDir } = await buildFixture();
    const service = new RangeStrataQueryService(join(outDir, "meta.db"), outDir);

    try {
      await expect(
        service.getHandStrategiesBatch({
          playerCount: 6,
          depthBb: 999,
          requests: [],
        }),
      ).resolves.toEqual([]);

      expect(
        service.getHandStrategiesBatchSync({
          playerCount: 6,
          depthBb: 999,
          requests: [],
        }),
      ).toEqual([]);

      expect(
        service.getHandStrategiesCountBatchSync({
          playerCount: 6,
          depthBb: 999,
          requests: [],
        }),
      ).toBe(0);
    } finally {
      service.close();
    }
  });

  test("non-existent dimensions report BIN_FILE_NOT_FOUND instead of masking the failure", async () => {
    const { outDir } = await buildFixture();
    const service = new RangeStrataQueryService(join(outDir, "meta.db"), outDir);

    try {
      await expect(
        service.getHandStrategy({
          playerCount: 6,
          depthBb: 999,
          concreteLineId: 1,
          holeCards: "AA",
        }),
      ).rejects.toMatchObject({ code: "BIN_FILE_NOT_FOUND" });

      const batch = await service.getHandStrategiesBatch({
        playerCount: 6,
        depthBb: 999,
        requests: [{ concreteLineId: 1, holeCards: "AA" }],
      });

      expect(batch).toHaveLength(1);
      expect(batch[0].strategy).toBeNull();
      expect(batch[0].error?.code).toBe("BIN_FILE_NOT_FOUND");

      expect(() =>
        service.getHandStrategySync({
          playerCount: 6,
          depthBb: 999,
          concreteLineId: 1,
          holeCards: "AA",
        }),
      ).toThrow(PreflopQueryError);
    } finally {
      service.close();
    }
  });

  test("getHandsByAction applies minFrequency as a strict lower bound", async () => {
    const { outDir } = await buildFixture();
    const service = new RangeStrataQueryService(join(outDir, "meta.db"), outDir);

    try {
      const atBoundary = await service.getHandsByAction({
        playerCount: 6,
        depthBb: 100,
        concreteLineId: 1,
        actionNames: ["call"],
        minFrequency: 0.5,
      });
      const belowBoundary = await service.getHandsByAction({
        playerCount: 6,
        depthBb: 100,
        concreteLineId: 1,
        actionNames: ["call"],
        minFrequency: 0.499,
      });
      const aboveBoundary = await service.getHandsByAction({
        playerCount: 6,
        depthBb: 100,
        concreteLineId: 1,
        actionNames: ["call"],
        minFrequency: 0.55,
      });

      expect(atBoundary).toEqual(["KK"]);
      expect(belowBoundary).toEqual(["AA", "KK"]);
      expect(aboveBoundary).toEqual(["KK"]);
    } finally {
      service.close();
    }
  });

  test("handEV preserves null separately from zero", async () => {
    const { outDir } = await buildFixture();
    const service = new RangeStrataQueryService(join(outDir, "meta.db"), outDir);

    try {
      const result = await service.getHandStrategy({
        playerCount: 6,
        depthBb: 100,
        concreteLineId: 1,
        holeCards: "KK",
      });

      expect(result?.actions).toEqual([
        expect.objectContaining({ actionName: "fold", handEV: null }),
        expect.objectContaining({ actionName: "call", handEV: 0 }),
        expect.objectContaining({ actionName: "raise", handEV: 3 }),
      ]);
    } finally {
      service.close();
    }
  });
});

async function buildFixture(): Promise<{ outDir: string }> {
  const rootDir = await mkdtemp(join(tmpdir(), "preflop-storage-range-strata-binary-"));
  tempDirs.push(rootDir);

  const sourcePath = join(rootDir, "range.db");
  const outDir = join(rootDir, "range-strata-binary");
  const db = new Database(sourcePath);

  try {
    db.exec(`
      CREATE TABLE concrete_lines_default_6max_100BB (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        abstract_line TEXT NOT NULL,
        concrete_line TEXT NOT NULL,
        UNIQUE(abstract_line, concrete_line)
      );

      CREATE TABLE drill_scenario_lines_default (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        drill_name TEXT NOT NULL,
        abstract_line TEXT NOT NULL,
        player_count INTEGER NOT NULL,
        depth INTEGER NOT NULL
      );

      CREATE TABLE range_data_default_6max_100BB (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        concrete_line_id INTEGER NOT NULL,
        hole_cards TEXT NOT NULL,
        action_name TEXT NOT NULL,
        action_size REAL NOT NULL,
        amount_bb REAL NOT NULL,
        frequency REAL NOT NULL,
        hand_ev REAL
      );
    `);

    db.query(`
      INSERT INTO concrete_lines_default_6max_100BB(id, abstract_line, concrete_line)
      VALUES
        (1, 'R-C', 'R2-C'),
        (2, 'R-C', 'R3.5-C')
    `).run();
    db.query(`
      INSERT INTO drill_scenario_lines_default(drill_name, abstract_line, player_count, depth)
      VALUES ('fixture', 'R-C', 6, 0)
    `).run();
    db.query(`
      INSERT INTO range_data_default_6max_100BB(
        concrete_line_id, hole_cards, action_name, action_size, amount_bb, frequency, hand_ev
      )
      VALUES
        (1, 'AA', 'fold', 0, 0, 0.1, 0),
        (1, 'AA', 'call', 0, 0, 0.5, 1),
        (1, 'AA', 'raise', 40, 2, 0.7, 2),
        (1, 'KK', 'fold', 0, 0, 0.3, NULL),
        (1, 'KK', 'call', 0, 0, 0.6, 0),
        (1, 'KK', 'raise', 40, 2, 0.1, 3),
        (2, 'A3o', 'fold', 0, 0, 0.6, 0),
        (2, 'A3o', 'call', 0, 0, 0.4, -1),
        (2, 'A3o', 'raise', 40, 2, 0, -2)
    `).run();
  } finally {
    db.close();
  }

  await buildRangeStrataBinaryStore({
    sourceDbPath: sourcePath,
    outDir,
    overwrite: true,
  });

  return { outDir };
}

async function removeTempDirWithRetry(dir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}
