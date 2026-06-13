import { Scheme2QueryService } from "../query/query-service";
import {
  type BatchBenchmarkItem,
  type ColdStartResult,
  getMemorySnapshot,
  type HandBenchmarkItem,
} from "../../benchmark/common";

export interface Scheme2BenchmarkRunnerOptions {
  verifyChecksums: boolean;
}

export class Scheme2BenchmarkRunner {
  private readonly service: Scheme2QueryService;

  constructor(
    metaDbPath: string,
    binaryDir: string,
    options: Scheme2BenchmarkRunnerOptions,
  ) {
    this.service = new Scheme2QueryService(metaDbPath, binaryDir, {
      verifyChecksums: options.verifyChecksums,
    });
  }

  warmup(dimensions: string[]): void {
    for (const key of dimensions) {
      const parts = key.split(":");
      if (parts.length !== 3) continue;
      const strategy = parts[0];
      const playerCount = Number(parts[1].replace("max", ""));
      const depthBb = Number(parts[2].replace("BB", ""));

      this.service.prewarmDimension({ strategy, playerCount, depthBb });
    }
  }

  getHandStrategy(item: HandBenchmarkItem): number {
    const strategy = this.service.getHandStrategySync({
      strategy: item.strategy,
      playerCount: item.playerCount,
      depthBb: item.depthBb,
      concreteLineId: item.concreteLineId,
      holeCards: item.holeCards,
    });

    return strategy?.actions.length ?? 0;
  }

  /** Async fallback for cold-start measurement (no prewarm needed). */
  async getHandStrategyAsync(item: HandBenchmarkItem): Promise<number> {
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

export async function measureScheme2ColdStart(params: {
  metaDbPath: string;
  binaryDir: string;
  options: Scheme2BenchmarkRunnerOptions;
  item: HandBenchmarkItem | undefined;
}): Promise<ColdStartResult | null> {
  if (!params.item) return null;

  const memoryBefore = getMemorySnapshot();
  const start = performance.now();
  const runner = new Scheme2BenchmarkRunner(params.metaDbPath, params.binaryDir, params.options);

  try {
    const resultCount = await runner.getHandStrategyAsync(params.item);
    return {
      operation: "open meta.db/idx/bin and run first hand query (scheme2)",
      totalMs: performance.now() - start,
      resultCount,
      memoryBefore,
      memoryAfter: getMemorySnapshot(),
    };
  } finally {
    await runner.close();
  }
}
