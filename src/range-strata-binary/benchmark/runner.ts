import { RangeStrataQueryService } from "../query/query-service";
import {
  type BatchBenchmarkItem,
  type ColdStartResult,
  getMemorySnapshot,
  type HandBenchmarkItem,
} from "../../benchmark/common";

export interface RangeStrataBenchmarkRunnerOptions {
  verifyChecksums: boolean;
  prewarmActionSchemas?: boolean;
  /** Max concurrently open mmap handles (LRU pool size). Benchmark defaults to a large value. */
  maxOpenHandles?: number;
  /** Attempt OS page cache eviction before cold-start measurement. */
  evictOsCache?: boolean;
}

export class RangeStrataBenchmarkRunner {
  private readonly service: RangeStrataQueryService;
  private readonly options: RangeStrataBenchmarkRunnerOptions;

  constructor(
    metaDbPath: string,
    binaryDir: string,
    options: RangeStrataBenchmarkRunnerOptions,
  ) {
    this.options = options;
    this.service = new RangeStrataQueryService(metaDbPath, binaryDir, {
      verifyChecksums: options.verifyChecksums,
      prewarmActionSchemas: options.prewarmActionSchemas,
      maxOpenHandles: options.maxOpenHandles ?? 100,
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

    if (this.options.prewarmActionSchemas) {
      this.service.prewarmActionSchemas();
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

  /** Sync batch query—requires prewarmed handles (warmup() already called). */
  getHandStrategiesBatchSync(item: BatchBenchmarkItem): number {
    const results = this.service.getHandStrategiesBatchSync({
      strategy: item.strategy,
      playerCount: item.playerCount,
      depthBb: item.depthBb,
      requests: item.requests,
    });

    let total = 0;
    for (const result of results) {
      total += result.strategy?.actions.length ?? 0;
    }
    return total;
  }

  /** Lightweight sync batch: returns total action count via Rust queryBatchCount, skipping JS assembly. */
  getHandStrategiesCountBatchSync(item: BatchBenchmarkItem): number {
    return this.service.getHandStrategiesCountBatchSync({
      strategy: item.strategy,
      playerCount: item.playerCount,
      depthBb: item.depthBb,
      requests: item.requests,
    });
  }

  async getHandStrategiesBatch(item: BatchBenchmarkItem): Promise<number> {
    const results = await this.service.getHandStrategiesBatch({
      strategy: item.strategy,
      playerCount: item.playerCount,
      depthBb: item.depthBb,
      requests: item.requests,
    });

    let total = 0;
    for (const result of results) {
      total += result.strategy?.actions.length ?? 0;
    }
    return total;
  }

  async close(): Promise<void> {
    await this.service.close();
  }
}

export async function measureRangeStrataColdStart(params: {
  metaDbPath: string;
  binaryDir: string;
  options: RangeStrataBenchmarkRunnerOptions;
  item: HandBenchmarkItem | undefined;
}): Promise<ColdStartResult | null> {
  if (!params.item) return null;

  // Attempt OS page cache eviction if requested
  if (params.options.evictOsCache) {
    await evictOsPageCache();
  }

  const memoryBefore = getMemorySnapshot();
  const start = performance.now();
  const runner = new RangeStrataBenchmarkRunner(params.metaDbPath, params.binaryDir, params.options);

  try {
    const resultCount = await runner.getHandStrategyAsync(params.item);
    return {
      operation: "open meta.db/idx/bin and run first hand query (range-strata-binary)",
      totalMs: performance.now() - start,
      resultCount,
      memoryBefore,
      memoryAfter: getMemorySnapshot(),
    };
  } finally {
    await runner.close();
  }
}

/**
 * Attempt to evict the OS page cache so that subsequent file reads hit disk.
 *
 * On Linux: tries /proc/sys/vm/drop_caches (requires root).
 * On Windows / all platforms: reads a large temporary file to fill the
 * system file cache, pushing out previously cached pages.
 *
 * Best-effort — if eviction fails or is unsupported, the cold-start
 * measurement will reflect a warm OS cache.
 */
async function evictOsPageCache(): Promise<void> {
  const platform = process.platform;

  if (platform === "linux") {
    try {
      await Bun.write("/proc/sys/vm/drop_caches", "1\n");
      await new Promise((resolve) => setTimeout(resolve, 100));
      return;
    } catch {
      // Fallback to large-file approach
    }
  }

  // Platform-agnostic approach: read a large temp file to fill the cache.
  // This pushes out previously cached data from the working set.
  const tmpDir = await import("node:os").then((m) => m.tmpdir());
  const { join } = await import("node:path");
  const cacheFiller = join(tmpDir, "preflop-cache-evict.bin");
  const fillerSize = (platform === "win32" ? 256 : 512) * 1024 * 1024; // 256 MB on Windows, 512 MB elsewhere

  try {
    // Write filler file
    const filler = new Uint8Array(64 * 1024); // 64 KB chunk
    const file = await import("node:fs/promises").then((m) => m.open(cacheFiller, "w"));
    let written = 0;
    while (written < fillerSize) {
      const chunk = Math.min(filler.byteLength, fillerSize - written);
      await file.write(filler.subarray(0, chunk), 0, chunk, written);
      written += chunk;
    }
    await file.close();

    // Read it back to fill the cache
    const readFile = await import("node:fs/promises").then((m) => m.open(cacheFiller, "r"));
    const readBuf = Buffer.allocUnsafe(1024 * 1024);
    let read = 0;
    while (read < fillerSize) {
      const result = await readFile.read(readBuf, 0, readBuf.length, read);
      if (result.bytesRead === 0) break;
      read += result.bytesRead;
    }
    await readFile.close();

    // Clean up
    try {
      await import("node:fs/promises").then((m) => m.rm(cacheFiller, { force: true }));
    } catch { /* ignore */ }
  } catch {
    // If file eviction fails, cold start will use warm cache
  }
}
