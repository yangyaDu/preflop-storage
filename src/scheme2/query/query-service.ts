import { Database } from "bun:sqlite";
import { join } from "node:path";
import { decodeActionSchema, normalizeActionName, type ActionDef, type ActionName } from "../../binary/action-schema-codec";
import { assertCrc32c } from "../../binary/crc32c";
import { decodeRangePackForHand, decodeRangePackMaskMatch } from "../../binary/range-pack-codec";
import { getHandCode, getHandId } from "../../hand/hand-dict";
import { PreflopQueryError, toPreflopQueryErrorInfo, type PreflopQueryErrorInfo } from "../../query/errors";
import {
  getBinFileName,
  getConcreteLinesTableName,
  getDrillScenarioTableName,
  quoteIdentifier,
} from "../../db/naming";
import { getIdxFileName } from "../db/naming";

// Rust native addon — replaces RangeIdxReader + RangeBinReader for the hot path.
import { DimensionHandle, type BatchQueryRequest, type PackDecodeResult } from "../../../native-addon/index.js";

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

export class Scheme2QueryService {
  private readonly metaDb: Database;
  private readonly handles = new Map<string, DimensionHandle>();
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

    if (this.handles.has(key)) return;

    const idxPath = join(this.binaryDir, idxFileName);
    const binPath = join(this.binaryDir, binFileName);

    try {
      const handle = new DimensionHandle(idxPath, binPath);
      this.handles.set(key, handle);
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

    // Build Rust batch query requests
    const rustRequests: BatchQueryRequest[] = [];
    const handIdMap = new Map<number, number>(); // index → handId

    for (let i = 0; i < params.requests.length; i++) {
      const req = params.requests[i];
      try {
        const handId = this.getKnownHandId(req.holeCards);
        rustRequests.push({ concreteLineId: req.concreteLineId, handId });
        handIdMap.set(i, handId);
      } catch (_error) {
        // Will be handled below
        handIdMap.set(i, -1);
        rustRequests.push({ concreteLineId: req.concreteLineId, handId: 0 }); // placeholder
      }
    }

    // Execute batch query in Rust
    const rustResults = handle.queryBatch(rustRequests, this.options.verifyChecksums ?? false);

    return params.requests.map((request, i) => {
      const handId = handIdMap.get(i);
      if (handId === undefined || handId === -1) {
        return {
          ...request,
          strategy: null,
          error: toPreflopQueryErrorInfo(
            new PreflopQueryError("UNKNOWN_HAND", `Unknown hole cards: ${request.holeCards}`, {
              holeCards: request.holeCards,
            }),
          ),
        };
      }

      const fragment = rustResults[i];
      if (!fragment) {
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

      const actions = this.getActionSchema(fragment.actionSchemaId);
      return {
        ...request,
        strategy: this.assembleHandStrategy(request.holeCards, fragment, actions),
        error: null,
      };
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

    // Prewarm the handle and read raw pack data for JS-side mask matching
    try {
      this.prewarmDimension({ strategy, playerCount: params.playerCount, depthBb: params.depthBb });
    } catch (error) {
      throw new PreflopQueryError("PACK_NOT_FOUND", error instanceof Error ? error.message : String(error), {
        strategy,
        playerCount: params.playerCount,
        depthBb: params.depthBb,
        concreteLineId: params.concreteLineId,
      });
    }

    const idxFileName = getIdxFileName(strategy, params.playerCount, params.depthBb);
    const binFileName = getBinFileName(strategy, params.playerCount, params.depthBb);
    const key = `${idxFileName}|${binFileName}`;
    const handle = this.handles.get(key)!;

    // Use the Rust handle for idx lookup and raw pack read
    // We need the IdxRecord fields: handCount, actionSchemaId, offset, byteLength
    // Since the Rust handle only exposes query() and queryBatch(), we need to
    // get the pack data. Let's query with any handId to get the actionSchemaId,
    // then use a separate mechanism for the raw pack data.
    //
    // For now, use a workaround: query with a handId we know exists.
    // This is suboptimal for getHandsByAction — a dedicated method would be better,
    // but this preserves the existing functionality.
    const fragment = handle.query(params.concreteLineId, 0, this.options.verifyChecksums);
    if (!fragment) return [];

    const actions = this.getActionSchema(fragment.actionSchemaId);

    // For the full mask-match algorithm, we need raw pack bytes.
    // The Rust handle doesn't expose raw pack data directly for this advanced path.
    // Fall back to reading the .bin file via Bun for this specific case.
    const fullPath = join(this.binaryDir, binFileName);
    const raw = await Bun.file(fullPath).bytes();

    // Since getHandsByAction is not the hot path, keep existing JS idx reader for it.
    const { RangeIdxReader } = await import("../idx/idx-reader");
    const idxPath = join(this.binaryDir, idxFileName);
    const idxReader = new RangeIdxReader(idxPath);
    await idxReader.open();

    try {
      const idxRecord = idxReader.find(params.concreteLineId);
      if (!idxRecord) return [];

      const bytes = raw.subarray(idxRecord.offset, idxRecord.offset + idxRecord.byteLength);

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
    } finally {
      idxReader.close();
    }
  }

  close(): void {
    // Rust Drop handles mmap cleanup automatically when handle is GC'd.
    // Clear the Map to release references.
    this.handles.clear();
    this.metaDb.close();
  }

  // ── 内部同步热路径（Rust-backed）──

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

    const actionBlob = new Uint8Array(
      schemaRow.action_blob.buffer,
      schemaRow.action_blob.byteOffset,
      schemaRow.action_blob.byteLength,
    );
    const actions = decodeActionSchema(actionBlob, schemaRow.action_count);
    this.actionCache.set(actionSchemaId, actions);
    return actions;
  }

  private getKnownHandId(holeCards: string): number {
    try {
      return getHandId(holeCards);
    } catch (_error) {
      throw new PreflopQueryError("UNKNOWN_HAND", `Unknown hole cards: ${holeCards}`, { holeCards });
    }
  }
}
