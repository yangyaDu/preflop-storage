interface MemorySnapshot {
  rssBytes: number;
  heapTotalBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
}

export {};

interface ColdWorkerTimings {
  supportModuleImportMs: number;
  argsParseMs: number;
  queryServiceImportMs: number;
  memorySnapshotMs: number;
  serviceConstructorMs: number;
  dimensionPrewarmMs: number;
  firstQueryMs: number;
  closeMs: number;
  workerTotalMs: number;
}

interface ColdWorkerResult {
  ok: boolean;
  storeOpenAndFirstQueryMs: number;
  resultCount: number;
  memoryBefore: MemorySnapshot;
  memoryAfter: MemorySnapshot;
  timings: ColdWorkerTimings;
  error: string | null;
}

interface DimensionParams {
  strategy?: string;
  playerCount: number;
  depthBb: number;
}

interface QueryParams extends DimensionParams {
  concreteLineId: number;
  holeCards: string;
}

interface QueryServiceLike {
  prewarmDimension(params: DimensionParams): void;
  getHandStrategySync(params: QueryParams): { actions: unknown[] } | null;
  close(): void | Promise<void>;
}

const workerStart = performance.now();
const timings: ColdWorkerTimings = {
  supportModuleImportMs: 0,
  argsParseMs: 0,
  queryServiceImportMs: 0,
  memorySnapshotMs: 0,
  serviceConstructorMs: 0,
  dimensionPrewarmMs: 0,
  firstQueryMs: 0,
  closeMs: 0,
  workerTotalMs: 0,
};

let result: ColdWorkerResult | null = null;
let service: QueryServiceLike | null = null;

try {
  const supportImportStart = performance.now();
  const argsModule = await import("../../cli/args");
  const commonModule = await import("../../benchmark/common");
  timings.supportModuleImportMs = performance.now() - supportImportStart;

  const argsParseStart = performance.now();
  const args = argsModule.parseCliArgs(Bun.argv.slice(2));
  const binaryDir = argsModule.getStringArg(args, "dir");
  const metaDbPath = argsModule.getStringArg(args, "meta", `${binaryDir}/meta.db`);
  const strategy = argsModule.getStringArg(args, "strategy", "default");
  const playerCount = argsModule.getNumberArg(args, "player-count");
  const depthBb = argsModule.getNumberArg(args, "depth-bb");
  const concreteLineId = argsModule.getNumberArg(args, "concrete-line-id");
  const holeCards = argsModule.getStringArg(args, "hand");
  const verifyChecksums = argsModule.getBooleanArg(args, "verify-checksum");
  timings.argsParseMs = performance.now() - argsParseStart;

  const queryServiceImportStart = performance.now();
  const { Scheme2QueryService } = await import("../query/query-service");
  timings.queryServiceImportMs = performance.now() - queryServiceImportStart;

  const memoryStart = performance.now();
  const memoryBefore = commonModule.getMemorySnapshot();
  timings.memorySnapshotMs = performance.now() - memoryStart;

  const constructorStart = performance.now();
  service = new Scheme2QueryService(metaDbPath, binaryDir, {
    verifyChecksums,
  });
  timings.serviceConstructorMs = performance.now() - constructorStart;

  const dimensionPrewarmStart = performance.now();
  service.prewarmDimension({
    strategy,
    playerCount,
    depthBb,
  });
  timings.dimensionPrewarmMs = performance.now() - dimensionPrewarmStart;

  const firstQueryStart = performance.now();
  const strategyResult = service.getHandStrategySync({
    strategy,
    playerCount,
    depthBb,
    concreteLineId,
    holeCards,
  });
  timings.firstQueryMs = performance.now() - firstQueryStart;

  result = {
    ok: true,
    storeOpenAndFirstQueryMs: timings.serviceConstructorMs + timings.dimensionPrewarmMs + timings.firstQueryMs,
    resultCount: strategyResult?.actions.length ?? 0,
    memoryBefore,
    memoryAfter: commonModule.getMemorySnapshot(),
    timings,
    error: null,
  };
} catch (error) {
  result = {
    ok: false,
    storeOpenAndFirstQueryMs: timings.serviceConstructorMs + timings.dimensionPrewarmMs + timings.firstQueryMs,
    resultCount: 0,
    memoryBefore: emptyMemorySnapshot(),
    memoryAfter: emptyMemorySnapshot(),
    timings,
    error: error instanceof Error ? error.message : String(error),
  };
} finally {
  const closeStart = performance.now();
  try {
    await service?.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (result) {
      result.ok = false;
      result.error = result.error ? `${result.error}; close failed: ${message}` : `close failed: ${message}`;
    }
  }
  timings.closeMs = performance.now() - closeStart;
  timings.workerTotalMs = performance.now() - workerStart;

  const finalResult = result ?? {
    ok: false,
    storeOpenAndFirstQueryMs: 0,
    resultCount: 0,
    memoryBefore: emptyMemorySnapshot(),
    memoryAfter: emptyMemorySnapshot(),
    timings,
    error: "Worker exited without producing a result.",
  };

  console.log(JSON.stringify(finalResult));
  if (!finalResult.ok) {
    process.exitCode = 1;
  }
}

function emptyMemorySnapshot(): MemorySnapshot {
  return {
    rssBytes: 0,
    heapTotalBytes: 0,
    heapUsedBytes: 0,
    externalBytes: 0,
    arrayBuffersBytes: 0,
  };
}
