import { Database } from "bun:sqlite";
import { type ActionDef } from "../../binary/action-schema-codec";
import { getHandId } from "../../hand/hand-dict";
import {
  PreflopQueryError,
  toPreflopQueryError,
  toPreflopQueryErrorInfo,
  type PreflopQueryErrorInfo,
} from "../../query/errors";
import {
  getConcreteLines as readConcreteLines,
  getDrillScenarioLines as readDrillScenarioLines,
  type ConcreteLineRow,
} from "../../db/meta-line-reader";
import { ActionSchemaCache } from "./action-schema-cache";
import { getHandsByActionFromStore } from "./action-filter";
import { DimensionHandlePool } from "./dimension-handle-pool";
import { parseFlatBatchResult, toBatchFatalErrorResults } from "./flat-batch-result";
import type {
  ActionResult,
  BatchHandStrategyRequest,
  BatchHandStrategyResult,
  HandStrategy,
  RangeStrataQueryServiceOptions,
} from "./types";

// Rust native addon — replaces RangeIdxReader + RangeBinReader for the hot path.
import { type BatchQueryRequest, type DimensionHandle, type PackDecodeResult } from "../../../native-addon/index.js";

export type { ConcreteLineRow } from "../../db/meta-line-reader";
export type {
  ActionResult,
  BatchHandStrategyRequest,
  BatchHandStrategyResult,
  HandStrategy,
  RangeStrataQueryServiceOptions,
} from "./types";

export class RangeStrataQueryService {
  private readonly metaDb: Database;
  private readonly actionSchemas: ActionSchemaCache;
  private readonly handlePool: DimensionHandlePool;

  constructor(
    metaDbPath: string,
    private readonly binaryDir: string,
    private readonly options: RangeStrataQueryServiceOptions = {},
  ) {
    this.metaDb = new Database(metaDbPath, { readonly: true });
    this.actionSchemas = new ActionSchemaCache(this.metaDb);
    this.handlePool = new DimensionHandlePool(this.binaryDir, this.options.maxOpenHandles ?? 3);
    if (this.options.prewarmActionSchemas) {
      this.prewarmActionSchemas();
    }
  }

  getDrillScenarioLines(params: {
    strategy?: string;
    drillName: string;
    playerCount: number;
    drillDepth?: number;
  }): string[] {
    return readDrillScenarioLines(this.metaDb, params);
  }

  getConcreteLines(params: {
    strategy?: string;
    playerCount: number;
    depthBb: number;
    abstractLine: string;
  }): ConcreteLineRow[] {
    return readConcreteLines(this.metaDb, params);
  }

  /**
   * 预热指定维度的 Rust DimensionHandle。
   * 预热后 getHandStrategySync 可零 async 开销调用。
   */
  prewarmDimension(params: {
    strategy?: string;
    playerCount: number;
    depthBb: number;
  }): void {
    const handle = this.handlePool.prewarm(params);
    this.prewarmActionSchemasForDimension(handle);
  }

  /**
   * Scan the dimension's .idx records and prewarm only the action schemas
   * actually referenced. Avoids eager full-schema loading while still keeping
   * the query hot-path free of meta.db round-trips.
   */
  prewarmActionSchemasForDimension(handle: DimensionHandle): number {
    return this.prewarmActionSchemas(handle.uniqueActionSchemaIds());
  }

  /**
   * 预热 action_schemas 到 TS 内存缓存。
   *
   * Rust 热路径返回 actionSchemaId + cell 数据；如果 schema 没有预热，
   * 第一次遇到新 schema 时仍会回 meta.db 查询，随机 workload 会被这个成本拖慢。
   */
  prewarmActionSchemas(actionSchemaIds?: Iterable<number>): number {
    return this.actionSchemas.prewarm(actionSchemaIds);
  }

  async getHandStrategy(params: {
    strategy?: string;
    playerCount: number;
    depthBb: number;
    concreteLineId: number;
    holeCards: string;
  }): Promise<HandStrategy | null> {
    const strategy = params.strategy ?? "default";
    const handle = this.handlePool.get(params);

    if (handle) {
      return this.queryHandSync(params.holeCards, params.concreteLineId, handle);
    }

    // 冷路径：需要打开文件
    try {
      const newHandle = this.handlePool.prewarm(params);
      this.prewarmActionSchemasForDimension(newHandle);
      return this.queryHandSync(params.holeCards, params.concreteLineId, newHandle);
    } catch (error) {
      throw toPreflopQueryError(error, "PACK_NOT_FOUND", {
        strategy,
        playerCount: params.playerCount,
        depthBb: params.depthBb,
        concreteLineId: params.concreteLineId,
      });
    }
  }

  /**
   * 同步版 getHandStrategy。要求通过 prewarmDimension() 提前预热对应维度的 handle。
   */
  getHandStrategySync(params: {
    strategy?: string;
    playerCount: number;
    depthBb: number;
    concreteLineId: number;
    holeCards: string;
  }): HandStrategy | null {
    const handle = this.handlePool.require(params);
    return this.queryHandSync(params.holeCards, params.concreteLineId, handle);
  }

  async getHandStrategiesBatch(params: {
    strategy?: string;
    playerCount: number;
    depthBb: number;
    requests: BatchHandStrategyRequest[];
  }): Promise<BatchHandStrategyResult[]> {
    if (params.requests.length === 0) return [];

    const strategy = params.strategy ?? "default";
    const { playerCount, depthBb } = params;

    // Get or prewarm the handle
    let handle: DimensionHandle;
    try {
      this.prewarmDimension({ strategy, playerCount, depthBb });
      handle = this.handlePool.require({ strategy, playerCount, depthBb });
    } catch (error) {
      return params.requests.map((request) => ({
        ...request,
        strategy: null,
        error: toPreflopQueryErrorInfo(error, "BIN_FILE_NOT_FOUND", {
          strategy,
          playerCount,
          depthBb,
        }),
      }));
    }

    return this.batchQuerySync(handle, params.requests);
  }

  /**
   * 同步版批量查询。要求通过 prewarmDimension() 提前预热对应维度的 handle。
   */
  getHandStrategiesBatchSync(params: {
    strategy?: string;
    playerCount: number;
    depthBb: number;
    requests: BatchHandStrategyRequest[];
  }): BatchHandStrategyResult[] {
    if (params.requests.length === 0) return [];

    const strategy = params.strategy ?? "default";
    const handle = this.handlePool.require({ strategy, playerCount: params.playerCount, depthBb: params.depthBb });
    return this.batchQuerySync(handle, params.requests);
  }

  /**
   * 轻量同步批量查询：仅返回总 action 计数，跳过 action schema 装配。
   * 用于 benchmark 等不需要完整 HandStrategy 的场景。
   */
  getHandStrategiesCountBatchSync(params: {
    strategy?: string;
    playerCount: number;
    depthBb: number;
    requests: BatchHandStrategyRequest[];
  }): number {
    if (params.requests.length === 0) return 0;

    const strategy = params.strategy ?? "default";
    const handle = this.handlePool.require({ strategy, playerCount: params.playerCount, depthBb: params.depthBb });
    const rustRequests: BatchQueryRequest[] = [];
    for (const req of params.requests) {
      const handId = this.getKnownHandId(req.holeCards);
      rustRequests.push({ concreteLineId: req.concreteLineId, handId });
    }

    let counts: Array<number | null | undefined>;
    try {
      counts = handle.queryBatchCount(rustRequests, this.options.verifyChecksums ?? false);
    } catch (error) {
      throw toPreflopQueryError(error, "INVALID_FORMAT", {
        strategy,
        playerCount: params.playerCount,
        depthBb: params.depthBb,
      });
    }
    let total = 0;
    for (const count of counts) {
      if (count != null) total += count;
    }
    return total;
  }

  async getHandsByAction(params: {
    strategy?: string;
    playerCount: number;
    depthBb: number;
    concreteLineId: number;
    actionNames?: string[];
    minFrequency?: number;
  }): Promise<string[]> {
    return getHandsByActionFromStore({
      binaryDir: this.binaryDir,
      verifyChecksums: this.options.verifyChecksums,
      actionSchemas: this.actionSchemas,
      query: params,
    });
  }

  close(): void {
    // Rust Drop handles mmap cleanup automatically when handle is GC'd.
    // Clear the Map to release references.
    this.handlePool.clear();
    this.metaDb.close();
  }

  // ── 内部同步热路径（Rust-backed）──

  private batchQuerySync(
    handle: DimensionHandle,
    requests: BatchHandStrategyRequest[],
  ): BatchHandStrategyResult[] {
    const rustRequests: BatchQueryRequest[] = [];
    const requestIndexes: number[] = [];
    const invalidHandErrors = new Map<number, PreflopQueryErrorInfo>();

    for (let i = 0; i < requests.length; i++) {
      const req = requests[i];
      try {
        const handId = this.getKnownHandId(req.holeCards);
        rustRequests.push({ concreteLineId: req.concreteLineId, handId });
        requestIndexes.push(i);
      } catch (error) {
        invalidHandErrors.set(i, toPreflopQueryErrorInfo(error));
      }
    }

    try {
      const flatBuffer = handle.queryBatchFlat(rustRequests, this.options.verifyChecksums ?? false);
      return parseFlatBatchResult({
        rawBuffer: flatBuffer,
        requests,
        requestIndexes,
        invalidHandErrors,
        actionSchemas: this.actionSchemas,
      });
    } catch (error) {
      return toBatchFatalErrorResults(requests, invalidHandErrors, error);
    }
  }

  private queryHandSync(
    holeCards: string,
    concreteLineId: number,
    handle: DimensionHandle,
  ): HandStrategy | null {
    const handId = this.getKnownHandId(holeCards);
    try {
      const fragment = handle.query(concreteLineId, handId, this.options.verifyChecksums);

      if (!fragment) return null;

      const actions = this.actionSchemas.get(fragment.actionSchemaId);
      return this.assembleHandStrategy(holeCards, fragment, actions);
    } catch (error) {
      throw toPreflopQueryError(error, "INVALID_FORMAT", {
        concreteLineId,
        holeCards,
      });
    }
  }

  private assembleHandStrategy(
    holeCards: string,
    fragment: PackDecodeResult,
    actions: ActionDef[],
  ): HandStrategy {
    if (fragment.cells.length === 0) {
      return { holeCards, exists: false, actions: [] };
    }

    const actionResults: ActionResult[] = [];
    for (const cell of fragment.cells) {
      const action = actions[cell.actionId];
      if (!action) continue;
      actionResults.push({
        actionName: action.actionName,
        actionSize: action.actionSize,
        amountBB: action.amountBB,
        frequency: cell.frequency,
        handEV: cell.handEv ?? null,
        exists: true,
      });
    }

    return { holeCards, exists: true, actions: actionResults };
  }

  private getKnownHandId(holeCards: string): number {
    try {
      return getHandId(holeCards);
    } catch (_error) {
      throw new PreflopQueryError("UNKNOWN_HAND", `Unknown hole cards: ${holeCards}`, { holeCards });
    }
  }
}
