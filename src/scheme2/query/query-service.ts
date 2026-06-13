import { Database } from "bun:sqlite";
import { join } from "node:path";
import { decodeActionSchema, normalizeActionName, type ActionDef, type ActionName } from "../../binary/action-schema-codec";
import { assertCrc32c } from "../../binary/crc32c";
import { RangeBinFileReader } from "../../binary/range-bin-file-reader";
import { RangeBinMmapReader } from "../../binary/range-bin-mmap-reader";
import { decodeRangePackForHand, decodeRangePackForHandDirect, decodeRangePackMaskMatch } from "../../binary/range-pack-codec";
import { getHandCode, getHandId } from "../../hand/hand-dict";
import { PreflopQueryError, toPreflopQueryErrorInfo, type PreflopQueryErrorInfo } from "../../query/errors";
import {
  getBinFileName,
  getConcreteLinesTableName,
  getDrillScenarioTableName,
  quoteIdentifier,
} from "../../db/naming";
import { getIdxFileName } from "../db/naming";
import { RangeIdxReader } from "../idx/idx-reader";
import type { IdxRecord } from "../idx/idx-types";

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
}

type BinReader = RangeBinMmapReader | RangeBinFileReader;

/** 大于等于该阈值的 .bin 文件使用按需 file reader 而非全量 mmap。 */
const FILE_READER_SIZE_THRESHOLD = 10 * 1024 * 1024; // 10 MB

export class Scheme2QueryService {
  private readonly metaDb: Database;
  private readonly binReaders = new Map<string, BinReader>();
  private readonly idxReaders = new Map<string, RangeIdxReader>();
  private readonly actionCache = new Map<number, ActionDef[]>();

  constructor(
    metaDbPath: string,
    private readonly binaryDir: string,
    private readonly options: Scheme2QueryServiceOptions = {},
  ) {
    this.metaDb = new Database(metaDbPath, { readonly: true });
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
   * 预热指定维度的 idx + bin reader。
   * 预热后 getHandStrategySync 可零 async 开销调用。
   */
  async prewarmDimension(params: {
    strategy?: string;
    playerCount: number;
    depthBb: number;
  }): Promise<void> {
    const strategy = params.strategy ?? "default";
    await this.getIdxReader({ strategy, playerCount: params.playerCount, depthBb: params.depthBb });
    await this.getBinReader({ strategy, playerCount: params.playerCount, depthBb: params.depthBb });
  }

  async getHandStrategy(params: {
    strategy?: string;
    playerCount: number;
    depthBb: number;
    concreteLineId: number;
    holeCards: string;
  }): Promise<HandStrategy | null> {
    const strategy = params.strategy ?? "default";

    // 同步热路径：reader 已缓存时，零内部 await
    const idxFileName = getIdxFileName(strategy, params.playerCount, params.depthBb);
    const binFileName = getBinFileName(strategy, params.playerCount, params.depthBb);
    const idxReader = this.idxReaders.get(idxFileName);
    const binReader = this.binReaders.get(binFileName);

    if (idxReader && binReader) {
      return this.queryHandSync(params.holeCards, params.concreteLineId, idxReader, binReader);
    }

    // 冷路径：需要打开文件
    const handId = this.getKnownHandId(params.holeCards);

    let idxRecord;
    try {
      idxRecord = await this.findIdxRecord({
        strategy,
        playerCount: params.playerCount,
        depthBb: params.depthBb,
        concreteLineId: params.concreteLineId,
      });
    } catch (error) {
      throw new PreflopQueryError("PACK_NOT_FOUND", error instanceof Error ? error.message : String(error), {
        strategy,
        playerCount: params.playerCount,
        depthBb: params.depthBb,
        concreteLineId: params.concreteLineId,
      });
    }

    if (!idxRecord) return null;

    const actions = this.getActionSchema(idxRecord.actionSchemaId);
    const reader = await this.getBinReader({
      strategy,
      playerCount: params.playerCount,
      depthBb: params.depthBb,
    });

    const raw = reader.readRaw(idxRecord.offset, idxRecord.byteLength);

    return decodeAndBuildActions(params.holeCards, handId, idxRecord, actions, {
      buffer: raw.buffer,
      byteOffset: raw.byteOffset,
      verifyChecksums: this.options.verifyChecksums,
      expectedChecksum: idxRecord.checksum,
    });
  }

  /**
   * 同步版 getHandStrategy。要求通过 prewarmDimension() 提前预热对应维度的 reader。
   * 零内部 await，零 microtask 开销。
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
    const idxReader = this.idxReaders.get(idxFileName);
    const binReader = this.binReaders.get(binFileName);

    if (!idxReader) {
      throw new PreflopQueryError("BIN_FILE_NOT_FOUND", `Idx reader not cached. Call prewarmDimension() first.`, {
        fileName: idxFileName,
      });
    }
    if (!binReader) {
      throw new PreflopQueryError("BIN_FILE_NOT_FOUND", `Bin reader not cached. Call prewarmDimension() first.`, {
        fileName: binFileName,
      });
    }

    return this.queryHandSync(params.holeCards, params.concreteLineId, idxReader, binReader);
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

    // Read all idx entries
    let idxMap: Map<number, IdxRecord | null>;
    try {
      const idxReader = await this.getIdxReader({ strategy, playerCount, depthBb });
      const concreteLineIds = [...new Set(params.requests.map((r) => r.concreteLineId))];
      const results = idxReader.findBatch(concreteLineIds);
      idxMap = new Map();
      for (let i = 0; i < concreteLineIds.length; i++) {
        idxMap.set(concreteLineIds[i], results[i]);
      }
    } catch (error) {
      return params.requests.map((request) => ({
        ...request,
        strategy: null,
        error: toPreflopQueryErrorInfo(error),
      }));
    }

    // Read all unique pack data
    const packDataMap = new Map<number, { actions: ActionDef[]; bytes: Uint8Array }>();
    const uniqueIdxRecords: Array<{ concreteLineId: number; idx: IdxRecord }> = [];

    for (const [concreteLineId, idx] of idxMap) {
      if (idx) {
        uniqueIdxRecords.push({ concreteLineId, idx });
      }
    }

    const readTasks = uniqueIdxRecords.map(async ({ concreteLineId, idx }) => {
      const actions = this.getActionSchema(idx.actionSchemaId);
      const binReader = await this.getBinReader({ strategy, playerCount, depthBb });
      const bytes = await binReader.read(idx.offset, idx.byteLength);

      if (this.options.verifyChecksums) {
        assertCrc32c(bytes, idx.checksum);
      }

      packDataMap.set(concreteLineId, { actions, bytes });
    });

    try {
      await Promise.all(readTasks);
    } catch (error) {
      const failedLineIds = new Set<number>();
      for (const { concreteLineId } of uniqueIdxRecords) {
        if (!packDataMap.has(concreteLineId)) {
          failedLineIds.add(concreteLineId);
        }
      }

      return params.requests.map((request) => {
        if (failedLineIds.has(request.concreteLineId) || !idxMap.has(request.concreteLineId)) {
          return { ...request, strategy: null, error: toPreflopQueryErrorInfo(error) };
        }

        const packData = packDataMap.get(request.concreteLineId)!;
        try {
          const strategy = this.decodeSingleHand(request, packData);
          return { ...request, strategy, error: null };
        } catch (handError) {
          return { ...request, strategy: null, error: toPreflopQueryErrorInfo(handError) };
        }
      });
    }

    return params.requests.map((request) => {
      const idx = idxMap.get(request.concreteLineId);

      if (!idx) {
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

      const packData = packDataMap.get(request.concreteLineId);
      if (!packData) {
        return { ...request, strategy: null, error: toPreflopQueryErrorInfo(new Error("Pack data read failed")) };
      }

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
    const strategy = params.strategy ?? "default";

    let idxRecord;
    try {
      idxRecord = await this.findIdxRecord({
        strategy,
        playerCount: params.playerCount,
        depthBb: params.depthBb,
        concreteLineId: params.concreteLineId,
      });
    } catch (error) {
      throw new PreflopQueryError("PACK_NOT_FOUND", error instanceof Error ? error.message : String(error), {
        strategy,
        playerCount: params.playerCount,
        depthBb: params.depthBb,
        concreteLineId: params.concreteLineId,
      });
    }

    if (!idxRecord) return [];

    const actions = this.getActionSchema(idxRecord.actionSchemaId);
    const reader = await this.getBinReader({ strategy, playerCount: params.playerCount, depthBb: params.depthBb });
    const bytes = await reader.read(idxRecord.offset, idxRecord.byteLength);

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
  }

  async close(): Promise<void> {
    for (const reader of this.binReaders.values()) {
      reader.close();
    }
    this.binReaders.clear();
    for (const reader of this.idxReaders.values()) {
      reader.close();
    }
    this.idxReaders.clear();
    this.metaDb.close();
  }

  // ── 内部同步热路径 ──
  // 假设 idxReader / binReader 已预热，所有调用零 await。

  private queryHandSync(
    holeCards: string,
    concreteLineId: number,
    idxReader: RangeIdxReader,
    binReader: BinReader,
  ): HandStrategy | null {
    const handId = this.getKnownHandId(holeCards);
    const idxRecord = idxReader.find(concreteLineId);
    if (!idxRecord) return null;

    const actions = this.getActionSchema(idxRecord.actionSchemaId);
    const raw = binReader.readRaw(idxRecord.offset, idxRecord.byteLength);

    return decodeAndBuildActions(holeCards, handId, idxRecord, actions, {
      buffer: raw.buffer,
      byteOffset: raw.byteOffset,
      verifyChecksums: this.options.verifyChecksums,
      expectedChecksum: idxRecord.checksum,
    });
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

    const actionBlob = new Uint8Array(
      schemaRow.action_blob.buffer,
      schemaRow.action_blob.byteOffset,
      schemaRow.action_blob.byteLength,
    );
    const actions = decodeActionSchema(actionBlob, schemaRow.action_count);
    this.actionCache.set(actionSchemaId, actions);
    return actions;
  }

  private async findIdxRecord(params: {
    strategy: string;
    playerCount: number;
    depthBb: number;
    concreteLineId: number;
  }) {
    const reader = await this.getIdxReader(params);
    return reader.find(params.concreteLineId);
  }

  private async getIdxReader(params: {
    strategy: string;
    playerCount: number;
    depthBb: number;
  }): Promise<RangeIdxReader> {
    const fileName = getIdxFileName(params.strategy, params.playerCount, params.depthBb);
    const cached = this.idxReaders.get(fileName);
    if (cached) return cached;

    const reader = new RangeIdxReader(join(this.binaryDir, fileName));
    try {
      await reader.open();
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        throw new PreflopQueryError("BIN_FILE_NOT_FOUND", `.idx file was not found: ${fileName}`, { fileName });
      }
      throw error;
    }
    this.idxReaders.set(fileName, reader);
    return reader;
  }

  private async getBinReader(params: {
    strategy: string;
    playerCount: number;
    depthBb: number;
  }): Promise<BinReader> {
    const fileName = getBinFileName(params.strategy, params.playerCount, params.depthBb);
    const cached = this.binReaders.get(fileName);
    if (cached) return cached;

    const fullPath = join(this.binaryDir, fileName);
    const fileSize = await Bun.file(fullPath).size;
    const reader: BinReader =
      fileSize >= FILE_READER_SIZE_THRESHOLD
        ? new RangeBinFileReader(fullPath)
        : new RangeBinMmapReader(fullPath);

    try {
      await reader.open();
    } catch (error) {
      throw this.toReaderOpenError(error, fileName);
    }
    this.binReaders.set(fileName, reader);
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

  private toReaderOpenError(error: unknown, fileName: string): PreflopQueryError {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return new PreflopQueryError("BIN_FILE_NOT_FOUND", `Binary range file was not found: ${fileName}`, { fileName });
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
      return new PreflopQueryError("UNSUPPORTED_DATA_VERSION", message, { fileName });
    }

    return new PreflopQueryError("BIN_FILE_NOT_FOUND", message, { fileName });
  }
}

// ── 零分配 helper：解码 pack → HandStrategy（供 sync 和 async 路径共享） ──

function decodeAndBuildActions(
  holeCards: string,
  handId: number,
  idxRecord: IdxRecord,
  actions: ActionDef[],
  raw: { buffer: ArrayBufferLike; byteOffset: number; verifyChecksums?: boolean; expectedChecksum?: number },
): HandStrategy | null {
  if (raw.verifyChecksums) {
    assertCrc32c(
      new Uint8Array(raw.buffer, raw.byteOffset, getRangePackByteLengthInternal(idxRecord.handCount, actions.length)),
      raw.expectedChecksum!,
    );
  }

  const cells = decodeRangePackForHandDirect({
    buffer: raw.buffer,
    packByteOffset: raw.byteOffset,
    handCount: idxRecord.handCount,
    actionCount: actions.length,
    targetHandId: handId,
  });

  if (cells.length === 0) {
    return { holeCards, exists: false, actions: [] };
  }

  const actionResults: ActionResult[] = [];
  for (const cell of cells) {
    const action = actions[cell.actionId];
    actionResults.push({
      actionName: action.actionName,
      actionSize: action.actionSize,
      amountBB: action.amountBB,
      frequency: cell.frequency,
      handEV: cell.handEV,
      exists: true,
    });
  }

  return { holeCards, exists: true, actions: actionResults };
}

function getRangePackByteLengthInternal(handCount: number, actionCount: number): number {
  return handCount * (5 + actionCount * 8);
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
