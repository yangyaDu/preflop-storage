import { getBinFileName } from "../db/naming";
import { PreflopQueryService } from "../query/preflop-query-service";
import {
  type BatchBenchmarkItem,
  type ColdStartResult,
  getMemorySnapshot,
  type HandBenchmarkItem,
} from "./common";

export interface BinaryBenchmarkRunnerOptions {
  verifyChecksums: boolean;
  packCacheSize: number;
}

export class BinaryBenchmarkRunner {
  private readonly service: PreflopQueryService;

  constructor(
    metaDbPath: string,
    binaryDir: string,
    options: BinaryBenchmarkRunnerOptions,
  ) {
    this.service = new PreflopQueryService(metaDbPath, binaryDir, {
      verifyChecksums: options.verifyChecksums,
      packCacheSize: options.packCacheSize,
    });
  }

  async warmup(dimensions: string[]): Promise<void> {
    for (const key of dimensions) {
      const parts = key.split(":");
      if (parts.length !== 3) continue;
      const strategy = parts[0];
      const playerCount = Number(parts[1].replace("max", ""));
      const depthBb = Number(parts[2].replace("BB", ""));

      this.service.metaDb.loadIndexCache(strategy, playerCount, depthBb);
      const binFile = getBinFileName(strategy, playerCount, depthBb);
      await this.service.getReader(binFile);
    }
  }

  async getHandStrategy(item: HandBenchmarkItem): Promise<number> {
    const strategy = await this.service.getHandStrategy({
      strategy: item.strategy,
      playerCount: item.playerCount,
      depthBb: item.depthBb,
      concreteLineId: item.concreteLineId,
      holeCards: item.holeCards,
    });

    return strategy?.actions.length ?? 0;
  }

  async getHandStrategiesBatch(item: BatchBenchmarkItem): Promise<number> {
    const results = await this.service.getHandStrategiesBatch({
      strategy: item.strategy,
      playerCount: item.playerCount,
      depthBb: item.depthBb,
      requests: item.requests,
    });

    return results.reduce((total, result) => total + (result.strategy?.actions.length ?? 0), 0);
  }

  async close(): Promise<void> {
    await this.service.close();
  }
}

export async function measureBinaryColdStart(params: {
  metaDbPath: string;
  binaryDir: string;
  options: BinaryBenchmarkRunnerOptions;
  item: HandBenchmarkItem | undefined;
}): Promise<ColdStartResult | null> {
  if (!params.item) return null;

  const memoryBefore = getMemorySnapshot();
  const start = performance.now();
  const runner = new BinaryBenchmarkRunner(params.metaDbPath, params.binaryDir, params.options);

  try {
    const resultCount = await runner.getHandStrategy(params.item);
    return {
      operation: "open meta.db/ranges file and run first hand query",
      totalMs: performance.now() - start,
      resultCount,
      memoryBefore,
      memoryAfter: getMemorySnapshot(),
    };
  } finally {
    await runner.close();
  }
}
