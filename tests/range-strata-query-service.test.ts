import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { RangeStrataQueryService } from "../src/range-strata-binary/query/service";
import { PreflopQueryError } from "../src/query/errors";
import { createBuiltRangeDbFixture, type RangeDimensionFixture } from "./helpers/range-db-fixture";
import { createTempDirRegistry } from "./helpers/temp-dir";

const tempDirs = createTempDirRegistry();

afterEach(tempDirs.cleanup);

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
  const { outDir } = await createBuiltRangeDbFixture({
    tempDirs,
    prefix: "preflop-storage-range-strata-binary-",
    spec: { dimensions: [queryServiceDimension] },
  });
  return { outDir };
}

const queryServiceDimension: RangeDimensionFixture = {
  playerCount: 6,
  depthBb: 100,
  concreteLines: [
    { id: 1, abstractLine: "R-C", concreteLine: "R2-C" },
    { id: 2, abstractLine: "R-C", concreteLine: "R3.5-C" },
  ],
  rangeRows: [
    { concreteLineId: 1, holeCards: "AA", actionName: "fold", actionSize: 0, amountBb: 0, frequency: 0.1, handEv: 0 },
    { concreteLineId: 1, holeCards: "AA", actionName: "call", actionSize: 0, amountBb: 0, frequency: 0.5, handEv: 1 },
    { concreteLineId: 1, holeCards: "AA", actionName: "raise", actionSize: 40, amountBb: 2, frequency: 0.7, handEv: 2 },
    { concreteLineId: 1, holeCards: "KK", actionName: "fold", actionSize: 0, amountBb: 0, frequency: 0.3, handEv: null },
    { concreteLineId: 1, holeCards: "KK", actionName: "call", actionSize: 0, amountBb: 0, frequency: 0.6, handEv: 0 },
    { concreteLineId: 1, holeCards: "KK", actionName: "raise", actionSize: 40, amountBb: 2, frequency: 0.1, handEv: 3 },
    { concreteLineId: 2, holeCards: "A3o", actionName: "fold", actionSize: 0, amountBb: 0, frequency: 0.6, handEv: 0 },
    { concreteLineId: 2, holeCards: "A3o", actionName: "call", actionSize: 0, amountBb: 0, frequency: 0.4, handEv: -1 },
    { concreteLineId: 2, holeCards: "A3o", actionName: "raise", actionSize: 40, amountBb: 2, frequency: 0, handEv: -2 },
  ],
};
