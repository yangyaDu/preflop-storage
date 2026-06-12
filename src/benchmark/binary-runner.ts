import { PreflopQueryService } from "../query/preflop-query-service";
import {
  type BatchBenchmarkItem,
  type ColdStartResult,
  getMemorySnapshot,
  type DrillBenchmarkItem,
  type FullRangeBenchmarkItem,
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

  async getFullRange(item: FullRangeBenchmarkItem): Promise<number> {
    const range = await this.service.getFullRange({
      strategy: item.strategy,
      playerCount: item.playerCount,
      depthBb: item.depthBb,
      concreteLineId: item.concreteLineId,
    });

    return range.reduce((total, hand) => total + hand.actions.length, 0);
  }

  async getDrillScenarioHandStrategies(item: DrillBenchmarkItem): Promise<number> {
    const strategies = await this.service.getScenarioHandStrategies({
      strategy: item.strategy,
      drillName: item.drillName,
      playerCount: item.playerCount,
      drillDepth: item.drillDepth,
      depthBb: item.depthBb,
      holeCards: item.holeCards,
    });

    return strategies.reduce((total, line) => total + line.strategy.actions.length, 0);
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
