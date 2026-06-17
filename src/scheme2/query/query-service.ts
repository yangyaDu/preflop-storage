import { Database } from "bun:sqlite";
import { join } from "node:path";
import { decodeActionSchema, normalizeActionName, type ActionDef, type ActionName } from "../../binary/action-schema-codec";
import { assertCrc32c } from "../../binary/crc32c";
import { RangeBinFileReader } from "../../binary/range-bin-file-reader";
import { decodeRangePackForHand, decodeRangePackMaskMatch } from "../../binary/range-pack-codec";
import { getHandCode, getHandId } from "../../hand/hand-dict";
import { PreflopQueryError, PreflopStoreError, toPreflopQueryErrorInfo, type PreflopQueryErrorInfo } from "../../query/errors";
import {
  getBinFileName,
  getConcreteLinesTableName,
  getDrillScenarioTableName,
  quoteIdentifier,
} from "../../db/naming";
import { getIdxFileName } from "../db/naming";
import { RangeIdxReader } from "../idx/idx-reader";

// Rust native addon — replaces RangeIdxReader + RangeBinReader for the hot path.
import { DimensionHandle, type BatchQueryRequest, type PackDecodeResult } from "../../../native-addon/index.js";

// Flat buffer protocol constants for query_batch_flat
const FLAT_MAGIC = 0x46425146; // "FQBF"
const FLAT_CELL_SIZE = 21;

export interface ActionResult {
  actionName: ActionName;
  actionSize: number;
  amountBB: number;
  frequency: number;
  handEV: number | null;
  exists: boolean;
}

export interface HandStrategy {
  holeCards: string;
  exists: boolean;
  actions: ActionResult[];
}

export interface BatchHandStrategyRequest {
  concreteLineId: number;
  holeCards: string;
}

export interface BatchHandStrategyResult extends BatchHandStrategyRequest {
  strategy: HandStrategy | null;
  error: PreflopQueryErrorInfo | null;
}

export interface ConcreteLineRow {
  concrete_line_id: number;
  abstract_line: string;
  concrete_line: string;
}

export interface ActionSchemaRow {
  id: number;
  action_count: number;
  action_blob: Uint8Array;
  checksum: number;
}

export interface Scheme2QueryServiceOptions {
  verifyChecksums?: boolean;
  prewarmActionSchemas?: boolean;
  /** Maximum number of concurrently open DimensionHandle mmaps. Default 3. */
  maxOpenHandles?: number;
}

export class Scheme2QueryService {
  private readonly metaDb: Database;
  private readonly handles = new Map<string, DimensionHandle>();
  private readonly actionCache = new Map<number, ActionDef[]>();
  private readonly handleLRU: string[] = []; // [oldest, ..., newest]
  private readonly maxOpenHandles: number;

  constructor(
    metaDbPath: string,
    private readonly binaryDir: string,
    private readonly options: Scheme2QueryServiceOptions = {},
  ) {
    this.metaDb = new Database(metaDbPath, { readonly: true });
    this.maxOpenHandles = this.options.maxOpenHandles ?? 3;
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
    const tableName = quoteIdentifier(getDrillScenarioTableName(params.strategy ?? "default"));
    const rows = this.metaDb
      .query(`
        SELECT abstract_line
        FROM ${tableName}
        WHERE drill_name = ?
          AND player_count = ?
          AND drill_depth = ?
        ORDER BY abstract_line
      `)
      .all(params.drillName, params.playerCount, params.drillDepth ?? 0) as Array<{
      abstract_line: string;
    }>;

    return rows.map((row) => row.abstract_line);
  }

  getConcreteLines(params: {
    strategy?: string;
    playerCount: number;
    depthBb: number;
    abstractLine: string;
  }): ConcreteLineRow[] {
    const tableName = quoteIdentifier(
      getConcreteLinesTableName(params.strategy ?? "default", params.playerCount, params.depthBb),
    );
    return this.metaDb
      .query(`
        SELECT concrete_line_id, abstract_line, concrete_line
        FROM ${tableName}
        WHERE abstract_line = ?
        ORDER BY concrete_line_id
      `)
      .all(params.abstractLine) as ConcreteLineRow[];
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
    const strategy = params.strategy ?? "default";
    const idxFileName = getIdxFileName(strategy, params.playerCount, params.depthBb);
    const binFileName = getBinFileName(strategy, params.playerCount, params.depthBb);
    const key = `${idxFileName}|${binFileName}`;

    if (this.handles.has(key)) {
      this.touchHandle(key);
      return;
    }

    const idxPath = join(this.binaryDir, idxFileName);
    const binPath = join(this.binaryDir, binFileName);

    try {
      const handle = new DimensionHandle(idxPath, binPath);
      this.handles.set(key, handle);
      this.touchHandle(key);
      this.evictLRU();
      this.prewarmActionSchemasForDimension(handle);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("ENOENT") || msg.includes("No such file")) {
        throw new PreflopQueryError("BIN_FILE_NOT_FOUND", `Index or binary file not found`, {
          idxFileName,
          binFileName,
        });
      }
      throw error;
    }
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
    if (actionSchemaIds) {
      let loaded = 0;
      for (const actionSchemaId of actionSchemaIds) {
        if (!this.actionCache.has(actionSchemaId)) {
          this.getActionSchema(actionSchemaId);
          loaded += 1;
        }
      }
      return loaded;
    }

    const rows = this.metaDb
      .query(`
        SELECT id, action_count, action_blob
        FROM action_schemas
        ORDER BY id
      `)
      .all() as ActionSchemaRow[];

    let loaded = 0;
    for (const row of rows) {
      if (this.actionCache.has(row.id)) continue;
      this.actionCache.set(row.id, this.decodeActionSchemaRow(row));
      loaded += 1;
    }

    return loaded;
  }

  async getHandStrategy(params: {
    strategy?: string;
    playerCount: number;
    depthBb: number;
    concreteLineId: number;
    holeCards: string;
  }): Promise<HandStrategy | null> {
    const strategy = params.strategy ?? "default";
    const idxFileName = getIdxFileName(strategy, params.playerCount, params.depthBb);
    const binFileName = getBinFileName(strategy, params.playerCount, params.depthBb);
    const key = `${idxFileName}|${binFileName}`;
    const handle = this.handles.get(key);

    if (handle) {
      this.touchHandle(key);
      return this.queryHandSync(params.holeCards, params.concreteLineId, handle);
    }

    // 冷路径：需要打开文件
    try {
      this.prewarmDimension(params);
    } catch (error) {
      throw new PreflopQueryError("PACK_NOT_FOUND", error instanceof Error ? error.message : String(error), {
        strategy,
        playerCount: params.playerCount,
        depthBb: params.depthBb,
        concreteLineId: params.concreteLineId,
      });
    }

    const newHandle = this.handles.get(key);
    if (!newHandle) return null;
    return this.queryHandSync(params.holeCards, params.concreteLineId, newHandle);
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
    const strategy = params.strategy ?? "default";
    const idxFileName = getIdxFileName(strategy, params.playerCount, params.depthBb);
    const binFileName = getBinFileName(strategy, params.playerCount, params.depthBb);
    const key = `${idxFileName}|${binFileName}`;
    const handle = this.handles.get(key);

    if (!handle) {
      throw new PreflopQueryError("BIN_FILE_NOT_FOUND", `Dimension handle not cached. Call prewarmDimension() first.`, {
        idxFileName,
        binFileName,
      });
    }

    this.touchHandle(key);
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
      const idxFileName = getIdxFileName(strategy, playerCount, depthBb);
      const binFileName = getBinFileName(strategy, playerCount, depthBb);
      const key = `${idxFileName}|${binFileName}`;
      handle = this.handles.get(key)!;
    } catch (error) {
      return params.requests.map((request) => ({
        ...request,
        strategy: null,
        error: toPreflopQueryErrorInfo(error),
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
    const idxFileName = getIdxFileName(strategy, params.playerCount, params.depthBb);
    const binFileName = getBinFileName(strategy, params.playerCount, params.depthBb);
    const key = `${idxFileName}|${binFileName}`;
    const handle = this.handles.get(key);

    if (!handle) {
      throw new PreflopQueryError("BIN_FILE_NOT_FOUND", `Dimension handle not cached. Call prewarmDimension() first.`, {
        idxFileName,
        binFileName,
      });
    }

    this.touchHandle(key);
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
    const idxFileName = getIdxFileName(strategy, params.playerCount, params.depthBb);
    const binFileName = getBinFileName(strategy, params.playerCount, params.depthBb);
    const key = `${idxFileName}|${binFileName}`;
    const handle = this.handles.get(key);

    if (!handle) {
      throw new PreflopQueryError("BIN_FILE_NOT_FOUND", `Dimension handle not cached. Call prewarmDimension() first.`, {
        idxFileName,
        binFileName,
      });
    }

    this.touchHandle(key);
    const rustRequests: BatchQueryRequest[] = [];
    for (const req of params.requests) {
      const handId = this.getKnownHandId(req.holeCards);
      rustRequests.push({ concreteLineId: req.concreteLineId, handId });
    }

    const counts = handle.queryBatchCount(rustRequests);
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
    const strategy = params.strategy ?? "default";
    const idxFileName = getIdxFileName(strategy, params.playerCount, params.depthBb);
    const binFileName = getBinFileName(strategy, params.playerCount, params.depthBb);
    const idxPath = join(this.binaryDir, idxFileName);
    const binPath = join(this.binaryDir, binFileName);
    const idxReader = new RangeIdxReader(idxPath);
    await idxReader.open();

    try {
      const idxRecord = idxReader.find(params.concreteLineId);
      if (!idxRecord) return [];

      const binReader = new RangeBinFileReader(binPath);
      binReader.open();

      let bytes: Uint8Array;
      try {
        bytes = binReader.read(idxRecord.offset, idxRecord.byteLength);
      } finally {
        binReader.close();
      }

      if (this.options.verifyChecksums) {
        try {
          assertCrc32c(bytes, idxRecord.checksum);
        } catch (error) {
          throw new PreflopQueryError("CHECKSUM_MISMATCH", error instanceof Error ? error.message : String(error), {
            concreteLineId: params.concreteLineId,
            expectedChecksum: idxRecord.checksum,
          });
        }
      }

      const actions = this.getActionSchema(idxRecord.actionSchemaId);

      const targetActionNames = params.actionNames;
      const minFrequency = params.minFrequency ?? 0;

      if (!targetActionNames || targetActionNames.length === 0) {
        const handIds = decodeRangePackMaskMatch({
          bytes,
          handCount: idxRecord.handCount,
          actionCount: actions.length,
          targetActionIds: [],
        });
        return handIds.map((handId) => getHandCode(handId));
      }

      const nameToActionIds = new Map<string, number[]>();
      for (const name of targetActionNames) {
        const normalized = normalizeActionName(name);
        for (const action of actions) {
          if (action.actionName === normalized) {
            const ids = nameToActionIds.get(normalized);
            if (ids) {
              ids.push(action.actionId);
            } else {
              nameToActionIds.set(normalized, [action.actionId]);
            }
          }
        }
      }

      if (nameToActionIds.size === 0) return [];

      const groupMasks: number[] = [];
      for (const ids of nameToActionIds.values()) {
        let groupMask = 0;
        for (const id of ids) {
          groupMask |= 1 << id;
        }
        groupMasks.push(groupMask);
      }

      const handCount = idxRecord.handCount;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const maskOffset = handCount;

      if (minFrequency <= 0) {
        const result: string[] = [];
        for (let i = 0; i < handCount; i++) {
          const mask = view.getUint32(maskOffset + i * 4, true);
          let allMatch = true;
          for (const groupMask of groupMasks) {
            if ((mask & groupMask) === 0) {
              allMatch = false;
              break;
            }
          }
          if (allMatch) {
            result.push(getHandCode(bytes[i]));
          }
        }
        return result;
      }

      const candidateHandIds: number[] = [];
      for (let i = 0; i < handCount; i++) {
        const mask = view.getUint32(maskOffset + i * 4, true);
        let allMatch = true;
        for (const groupMask of groupMasks) {
          if ((mask & groupMask) === 0) {
            allMatch = false;
            break;
          }
        }
        if (allMatch) {
          candidateHandIds.push(bytes[i]);
        }
      }

      if (candidateHandIds.length === 0) return [];

      const result: string[] = [];
      for (const handId of candidateHandIds) {
        const cells = decodeRangePackForHand({
          bytes,
          handCount,
          actionCount: actions.length,
          targetHandId: handId,
        });

        let allGroupsSatisfied = true;
        for (const actionIds of nameToActionIds.values()) {
          let groupSatisfied = false;
          for (const actionId of actionIds) {
            const cell = cells.find((c) => c.actionId === actionId);
            if (cell && cell.exists && cell.frequency > minFrequency) {
              groupSatisfied = true;
              break;
            }
          }
          if (!groupSatisfied) {
            allGroupsSatisfied = false;
            break;
          }
        }

        if (allGroupsSatisfied) {
          result.push(getHandCode(handId));
        }
      }

      return result;
    } finally {
      idxReader.close();
    }
  }

  close(): void {
    // Rust Drop handles mmap cleanup automatically when handle is GC'd.
    // Clear the Map to release references.
    this.handles.clear();
    this.handleLRU.length = 0;
    this.metaDb.close();
  }

  // ── LRU handle pool ──

  private touchHandle(key: string): void {
    const idx = this.handleLRU.indexOf(key);
    if (idx !== -1) this.handleLRU.splice(idx, 1);
    this.handleLRU.push(key);
  }

  private evictLRU(): void {
    while (this.handleLRU.length > this.maxOpenHandles) {
      const oldest = this.handleLRU.shift()!;
      this.handles.delete(oldest);
    }
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

    const flatBuffer = handle.queryBatchFlat(rustRequests, this.options.verifyChecksums ?? false);
    return this.parseFlatBatchResult(flatBuffer as unknown as Buffer, requests, requestIndexes, invalidHandErrors);
  }

  /**
   * Parse the flat binary buffer from `query_batch_flat` directly into
   * `BatchHandStrategyResult[]`, bypassing napi object serialization for
   * DecodedCellResult objects.
   */
  private parseFlatBatchResult(
    rawBuffer: Buffer | Uint8Array,
    requests: BatchHandStrategyRequest[],
    requestIndexes: number[],
    invalidHandErrors: Map<number, PreflopQueryErrorInfo>,
  ): BatchHandStrategyResult[] {
    // napi-rs Vec<u8> returns different types depending on runtime (Node Buffer, Bun Uint8Array, etc.).
    // Normalize to a Uint8Array so we can reliably access .buffer/.byteOffset/.byteLength.
    const flat = rawBuffer instanceof Uint8Array ? rawBuffer : new Uint8Array(rawBuffer as Iterable<number>);
    const view = new DataView(flat.buffer, flat.byteOffset, flat.byteLength);
    let offset = 0;

    // Header
    const magic = view.getUint32(offset, true);
    if (magic !== FLAT_MAGIC) {
      throw new PreflopStoreError("INVALID_FORMAT", `Invalid flat buffer magic: 0x${magic.toString(16)}`, { expected: FLAT_MAGIC, got: magic });
    }
    offset += 4;
    const requestCount = view.getUint32(offset, true);
    offset += 4;
    /* hitCount = */ offset += 4;

    // Per-request table
    const perRequestMeta: { cellCount: number; schemaId: number }[] = [];
    for (let i = 0; i < requestCount; i++) {
      const cellCount = view.getUint16(offset, true);
      offset += 2;
      /* reserved = */ offset += 2;
      const schemaId = view.getUint32(offset, true);
      offset += 4;
      perRequestMeta.push({ cellCount, schemaId });
    }

    // Pre-warm all needed action schemas in one batch
    for (const { cellCount, schemaId } of perRequestMeta) {
      if (cellCount > 0) {
        this.getActionSchema(schemaId);
      }
    }

    // Cell data section — read and assemble strategies in-place
    const resultByIndex = new Map<number, HandStrategy | null>();

    for (let i = 0; i < requestCount; i++) {
      const originalIdx = requestIndexes[i];
      const { cellCount, schemaId } = perRequestMeta[i];

      if (cellCount === 0) {
        resultByIndex.set(originalIdx, null);
        continue;
      }

      const actions = this.actionCache.get(schemaId);
      if (!actions) {
        resultByIndex.set(originalIdx, null);
        offset += cellCount * FLAT_CELL_SIZE;
        continue;
      }

      const actionResults: ActionResult[] = [];
      for (let j = 0; j < cellCount; j++) {
        const actionId = view.getUint32(offset, true);
        offset += 4;
        const frequency = view.getFloat64(offset, true);
        offset += 8;
        const evFlag = view.getUint8(offset);
        offset += 1;
        const handEvRaw = view.getFloat64(offset, true);
        offset += 8;

        const action = actions[actionId];
        if (!action) continue;
        actionResults.push({
          actionName: action.actionName,
          actionSize: action.actionSize,
          amountBB: action.amountBB,
          frequency,
          handEV: evFlag ? handEvRaw : null,
          exists: true,
        });
      }

      const holeCards = requests[originalIdx].holeCards;
      resultByIndex.set(originalIdx, { holeCards, exists: true, actions: actionResults });
    }

    // Assemble final results
    return requests.map((request, i) => {
      const invalidHandError = invalidHandErrors.get(i);
      if (invalidHandError) {
        return { ...request, strategy: null, error: invalidHandError };
      }

      const strategy = resultByIndex.get(i);
      if (!strategy) {
        return {
          ...request,
          strategy: null,
          error: toPreflopQueryErrorInfo(
            new PreflopQueryError("PACK_NOT_FOUND", `Range pack not found for concrete line ${request.concreteLineId}`, {
              concreteLineId: request.concreteLineId,
            }),
          ),
        };
      }

      return { ...request, strategy, error: null };
    });
  }

  private queryHandSync(
    holeCards: string,
    concreteLineId: number,
    handle: DimensionHandle,
  ): HandStrategy | null {
    const handId = this.getKnownHandId(holeCards);
    const fragment = handle.query(concreteLineId, handId, this.options.verifyChecksums);

    if (!fragment) return null;

    const actions = this.getActionSchema(fragment.actionSchemaId);
    return this.assembleHandStrategy(holeCards, fragment, actions);
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

  private getActionSchema(actionSchemaId: number): ActionDef[] {
    const cached = this.actionCache.get(actionSchemaId);
    if (cached) return cached;

    const schemaRow = this.metaDb
      .query(`
        SELECT id, action_count, action_blob
        FROM action_schemas
        WHERE id = ?
      `)
      .get(actionSchemaId) as ActionSchemaRow | null;

    if (!schemaRow) {
      throw new PreflopQueryError("ACTION_SCHEMA_NOT_FOUND", `Missing action schema: ${actionSchemaId}`, {
        actionSchemaId,
      });
    }

    const actions = this.decodeActionSchemaRow(schemaRow);
    this.actionCache.set(actionSchemaId, actions);
    return actions;
  }

  private decodeActionSchemaRow(schemaRow: ActionSchemaRow): ActionDef[] {
    const actionBlob = new Uint8Array(
      schemaRow.action_blob.buffer,
      schemaRow.action_blob.byteOffset,
      schemaRow.action_blob.byteLength,
    );
    return decodeActionSchema(actionBlob, schemaRow.action_count);
  }

  private getKnownHandId(holeCards: string): number {
    try {
      return getHandId(holeCards);
    } catch (_error) {
      throw new PreflopQueryError("UNKNOWN_HAND", `Unknown hole cards: ${holeCards}`, { holeCards });
    }
  }
}
