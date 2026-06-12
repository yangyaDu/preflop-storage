import { join } from "node:path";
import { decodeActionSchema, normalizeActionName, type ActionDef, type ActionName } from "../binary/action-schema-codec";
import { assertCrc32c } from "../binary/crc32c";
import { RangeBinMmapReader } from "../binary/range-bin-mmap-reader";
import { decodeRangePackForHand, decodeRangePackMaskMatch } from "../binary/range-pack-codec";
import { MetaDb, type RangePackIndexRow } from "../db/meta-db";
import { getHandCode, getHandId } from "../hand/hand-dict";
import { PreflopQueryError, toPreflopQueryErrorInfo, type PreflopQueryErrorInfo } from "./errors";

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

export interface PreflopQueryServiceOptions {
  verifyChecksums?: boolean;
  packCacheSize?: number;
}

export class PreflopQueryService {
  public readonly metaDb: MetaDb;
  private readonly readers = new Map<string, RangeBinMmapReader>();
  private readonly actionCache = new Map<number, ActionDef[]>();

  constructor(
    metaDbPath: string,
    private readonly binaryDir: string,
    private readonly options: PreflopQueryServiceOptions = {},
  ) {
    this.metaDb = new MetaDb(metaDbPath, { readonly: true });
  }

  getDrillScenarioLines(params: {
    strategy?: string;
    drillName: string;
    playerCount: number;
    drillDepth?: number;
  }): string[] {
    return this.metaDb.getDrillScenarioLines(params);
  }

  getConcreteLines(params: {
    strategy?: string;
    playerCount: number;
    depthBb: number;
    abstractLine: string;
  }) {
    return this.metaDb.getConcreteLines(params);
  }

  async getHandStrategy(params: {
    strategy?: string;
    playerCount: number;
    depthBb: number;
    concreteLineId: number;
    holeCards: string;
  }): Promise<HandStrategy | null> {
    const handId = this.getKnownHandId(params.holeCards);

    let packIndex: RangePackIndexRow | null;
    try {
      packIndex = this.metaDb.getRangePackIndex(params);
    } catch (error) {
      throw new PreflopQueryError("PACK_NOT_FOUND", error instanceof Error ? error.message : String(error), {
        strategy: params.strategy ?? "default",
        playerCount: params.playerCount,
        depthBb: params.depthBb,
        concreteLineId: params.concreteLineId,
      });
    }

    if (!packIndex) return null;

    const actions = this.getActionSchema(packIndex.action_schema_id);
    const reader = await this.getReader(packIndex.bin_file);
    const bytes = await reader.read(packIndex.offset, packIndex.byte_length);

    if (this.options.verifyChecksums) {
      try {
        assertCrc32c(bytes, packIndex.checksum);
      } catch (error) {
        throw new PreflopQueryError("CHECKSUM_MISMATCH", error instanceof Error ? error.message : String(error), {
          binFile: packIndex.bin_file,
          concreteLineId: packIndex.concrete_line_id,
          expectedChecksum: packIndex.checksum,
        });
      }
    }

    const cells = decodeRangePackForHand({
      bytes,
      handCount: packIndex.hand_count,
      actionCount: actions.length,
      targetHandId: handId,
    });

    if (cells.length === 0) {
      return {
        holeCards: params.holeCards,
        exists: false,
        actions: [],
      };
    }

    return {
      holeCards: params.holeCards,
      exists: true,
      actions: cellsToActionResults(cells, actions),
    };
  }

  async getHandStrategiesBatch(params: {
    strategy?: string;
    playerCount: number;
    depthBb: number;
    requests: BatchHandStrategyRequest[];
  }): Promise<BatchHandStrategyResult[]> {
    if (params.requests.length === 0) return [];

    // 步骤 1：按 concreteLineId 分组
    const groupMap = new Map<number, BatchHandStrategyRequest[]>();
    for (const request of params.requests) {
      const group = groupMap.get(request.concreteLineId);
      if (group) {
        group.push(request);
      } else {
        groupMap.set(request.concreteLineId, [request]);
      }
    }

    const concreteLineIds = [...groupMap.keys()];

    // 步骤 2：批量查询 metaDb（一次 SQL）
    let packIndexes: RangePackIndexRow[];
    try {
      packIndexes = this.metaDb.getRangePackIndexBatch({
        strategy: params.strategy,
        playerCount: params.playerCount,
        depthBb: params.depthBb,
        concreteLineIds,
      });
    } catch (error) {
      // 批量查询失败时，所有 requests 都报错
      return params.requests.map((request) => ({
        ...request,
        strategy: null,
        error: toPreflopQueryErrorInfo(error),
      }));
    }

    // 建立 concreteLineId → packIndex 的映射
    const packIndexMap = new Map<number, RangePackIndexRow>();
    for (const packIndex of packIndexes) {
      packIndexMap.set(packIndex.concrete_line_id, packIndex);
    }

    // 步骤 3：并行读取所有 pack 的二进制数据
    const packDataMap = new Map<number, { actions: ActionDef[]; bytes: Uint8Array }>();
    const readTasks = packIndexes.map(async (packIndex) => {
      const actions = this.getActionSchema(packIndex.action_schema_id);
      const reader = await this.getReader(packIndex.bin_file);
      const bytes = await reader.read(packIndex.offset, packIndex.byte_length);

      if (this.options.verifyChecksums) {
        assertCrc32c(bytes, packIndex.checksum);
      }

      packDataMap.set(packIndex.concrete_line_id, { actions, bytes });
    });

    try {
      await Promise.all(readTasks);
    } catch (error) {
      // 如果并行读取有错，尝试找出哪些 concreteLineIds 受影响
      // 对于部分失败，将对应 requests 标记为错误
      const failedLineIds = new Set<number>();
      for (const packIndex of packIndexes) {
        if (!packDataMap.has(packIndex.concrete_line_id)) {
          failedLineIds.add(packIndex.concrete_line_id);
        }
      }

      return params.requests.map((request) => {
        if (failedLineIds.has(request.concreteLineId) || !packIndexMap.has(request.concreteLineId)) {
          return {
            ...request,
            strategy: null,
            error: toPreflopQueryErrorInfo(error),
          };
        }

        // 这个 concreteLineId 的数据已经读取成功
        const packData = packDataMap.get(request.concreteLineId)!;
        try {
          const strategy = this.decodeSingleHand(request, packData);
          return { ...request, strategy, error: null };
        } catch (handError) {
          return { ...request, strategy: null, error: toPreflopQueryErrorInfo(handError) };
        }
      });
    }

    // 步骤 4：按需解码每个 request
    return params.requests.map((request) => {
      const packIndex = packIndexMap.get(request.concreteLineId);

      if (!packIndex) {
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

      const packData = packDataMap.get(request.concreteLineId)!;
      try {
        const strategy = this.decodeSingleHand(request, packData);
        return { ...request, strategy, error: null };
      } catch (error) {
        return { ...request, strategy: null, error: toPreflopQueryErrorInfo(error) };
      }
    });
  }

  async getHandsByAction(params: {
    strategy?: string;
    playerCount: number;
    depthBb: number;
    concreteLineId: number;
    actionNames?: string[];
    minFrequency?: number;
  }): Promise<string[]> {
    let packIndex: RangePackIndexRow | null;
    try {
      packIndex = this.metaDb.getRangePackIndex(params);
    } catch (error) {
      throw new PreflopQueryError("PACK_NOT_FOUND", error instanceof Error ? error.message : String(error), {
        strategy: params.strategy ?? "default",
        playerCount: params.playerCount,
        depthBb: params.depthBb,
        concreteLineId: params.concreteLineId,
      });
    }

    if (!packIndex) return [];

    const actions = this.getActionSchema(packIndex.action_schema_id);
    const reader = await this.getReader(packIndex.bin_file);
    const bytes = await reader.read(packIndex.offset, packIndex.byte_length);

    if (this.options.verifyChecksums) {
      try {
        assertCrc32c(bytes, packIndex.checksum);
      } catch (error) {
        throw new PreflopQueryError("CHECKSUM_MISMATCH", error instanceof Error ? error.message : String(error), {
          binFile: packIndex.bin_file,
          concreteLineId: packIndex.concrete_line_id,
          expectedChecksum: packIndex.checksum,
        });
      }
    }

    const targetActionNames = params.actionNames;
    const minFrequency = params.minFrequency ?? 0;

    // 没有 actionNames → 返回 pack 中所有手牌
    if (!targetActionNames || targetActionNames.length === 0) {
      const handIds = decodeRangePackMaskMatch({
        bytes,
        handCount: packIndex.hand_count,
        actionCount: actions.length,
        targetActionIds: [],
      });
      return handIds.map((handId) => getHandCode(handId));
    }

    // 将 actionNames 按标准化名称分组为多组 actionId
    // 每组（per actionName）要求至少匹配一个 actionId（OR 逻辑）
    // 不同组之间要求同时匹配（AND 逻辑）
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

    // 构建每组的掩码
    const groupMasks: number[] = [];
    for (const ids of nameToActionIds.values()) {
      let groupMask = 0;
      for (const id of ids) {
        groupMask |= 1 << id;
      }
      groupMasks.push(groupMask);
    }

    const handCount = packIndex.hand_count;

    // 候选列表：掩码匹配（action 存在性）
    // 使用 DataView 读取 masks（起始位置可能不对齐 4 字节）
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const maskOffset = handCount; // handIds 占 handCount 字节（actionMasks 紧随其后）

    if (minFrequency <= 0) {
      // 纯掩码匹配，不需要读 cell 数据
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

    // 需要检查频率：先用掩码筛选候选，再用按需解码验证频率
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

    // 对每个候选手牌，按需解码并验证频率
    const result: string[] = [];
    for (const handId of candidateHandIds) {
      const cells = decodeRangePackForHand({
        bytes,
        handCount,
        actionCount: actions.length,
        targetHandId: handId,
      });

      // 验证每组中至少有一个 action 频率达标
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
  }

  async close(): Promise<void> {
    for (const reader of this.readers.values()) {
      await reader.close();
    }
    this.readers.clear();
    this.metaDb.close();
  }

  private getActionSchema(actionSchemaId: number): ActionDef[] {
    const cached = this.actionCache.get(actionSchemaId);
    if (cached) return cached;

    const schemaRow = this.metaDb.getActionSchema(actionSchemaId);
    if (!schemaRow) {
      throw new PreflopQueryError("ACTION_SCHEMA_NOT_FOUND", `Missing action schema: ${actionSchemaId}`, {
        actionSchemaId,
      });
    }

    const actions = decodeActionSchema(schemaRow.action_blob, schemaRow.action_count);
    this.actionCache.set(actionSchemaId, actions);
    return actions;
  }

  public async getReader(binFile: string): Promise<RangeBinMmapReader> {
    const cached = this.readers.get(binFile);
    if (cached) return cached;

    const reader = new RangeBinMmapReader(join(this.binaryDir, binFile));
    try {
      await reader.open();
    } catch (error) {
      throw this.toReaderOpenError(error, binFile);
    }
    this.readers.set(binFile, reader);
    return reader;
  }

  private decodeSingleHand(
    request: BatchHandStrategyRequest,
    packData: { actions: ActionDef[]; bytes: Uint8Array },
  ): HandStrategy {
    let handId: number;
    try {
      handId = getHandId(request.holeCards);
    } catch (_error) {
      throw new PreflopQueryError("UNKNOWN_HAND", `Unknown hole cards: ${request.holeCards}`, {
        holeCards: request.holeCards,
      });
    }

    // 需要 handCount 来计算偏移 — 从 packIndex 可推导，但这里我们没有 packIndex。
    // handCount 可以从 bytes 长度反向推导：
    // byteLength = handCount * (5 + actionCount * 8)
    // handCount = byteLength / (5 + actionCount * 8)
    const actionCount = packData.actions.length;
    const handCount = Math.floor(packData.bytes.byteLength / (5 + actionCount * 8));

    const cells = decodeRangePackForHand({
      bytes: packData.bytes,
      handCount,
      actionCount,
      targetHandId: handId,
    });

    if (cells.length === 0) {
      return {
        holeCards: request.holeCards,
        exists: false,
        actions: [],
      };
    }

    return {
      holeCards: request.holeCards,
      exists: true,
      actions: cellsToActionResults(cells, packData.actions),
    };
  }

  private getKnownHandId(holeCards: string): number {
    try {
      return getHandId(holeCards);
    } catch (_error) {
      throw new PreflopQueryError("UNKNOWN_HAND", `Unknown hole cards: ${holeCards}`, { holeCards });
    }
  }

  private toReaderOpenError(error: unknown, binFile: string): PreflopQueryError {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return new PreflopQueryError("BIN_FILE_NOT_FOUND", `Binary range file was not found: ${binFile}`, { binFile });
    }

    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("Unsupported PFSP version") ||
      message.includes("Invalid ranges.bin magic") ||
      message.includes("Unsupported endian") ||
      message.includes("Unsupported float type") ||
      message.includes("Unsupported layout") ||
      message.includes("Unsupported compression") ||
      message.includes("Unsupported header size")
    ) {
      return new PreflopQueryError("UNSUPPORTED_DATA_VERSION", message, { binFile });
    }

    return new PreflopQueryError("BIN_FILE_NOT_FOUND", message, { binFile });
  }
}

function cellsToActionResults(
  cells: Array<{ actionId: number; exists: boolean; frequency: number; handEV: number | null }>,
  actions: ActionDef[],
): ActionResult[] {
  const results: ActionResult[] = [];
  for (const cell of cells) {
    if (!cell.exists) continue;
    const action = actions[cell.actionId];
    results.push({
      actionName: action.actionName,
      actionSize: action.actionSize,
      amountBB: action.amountBB,
      frequency: cell.frequency,
      handEV: cell.handEV,
      exists: true,
    });
  }
  return results;
}

function isErrnoException(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}
