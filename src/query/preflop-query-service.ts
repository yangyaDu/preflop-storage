import { join } from "node:path";
import { decodeActionSchema, normalizeActionName, type ActionDef, type ActionName } from "../binary/action-schema-codec";
import { assertCrc32c } from "../binary/crc32c";
import { RangeBinReader } from "../binary/range-bin-reader";
import { decodeRangePack, type DecodedRangePack } from "../binary/range-pack-codec";
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

export interface ScenarioConcreteLine {
  abstractLine: string;
  concreteLineId: number;
  concreteLine: string;
}

export interface ScenarioHandStrategy extends ScenarioConcreteLine {
  strategy: HandStrategy;
}

export interface PreflopQueryServiceOptions {
  verifyChecksums?: boolean;
  packCacheSize?: number;
}

interface DecodedPackContext {
  packIndex: RangePackIndexRow;
  actions: ActionDef[];
  decoded: DecodedRangePack;
}

export class PreflopQueryService {
  private readonly metaDb: MetaDb;
  private readonly readers = new Map<string, RangeBinReader>();
  private readonly actionCache = new Map<number, ActionDef[]>();
  private readonly packCache = new Map<string, DecodedPackContext>();

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

  getScenarioConcreteLines(params: {
    strategy?: string;
    drillName: string;
    playerCount: number;
    drillDepth?: number;
    depthBb: number;
  }): ScenarioConcreteLine[] {
    const abstractLines = this.getDrillScenarioLines(params);
    return abstractLines.flatMap((abstractLine) =>
      this.getConcreteLines({
        strategy: params.strategy,
        playerCount: params.playerCount,
        depthBb: params.depthBb,
        abstractLine,
      }).map((line) => ({
        abstractLine,
        concreteLineId: line.concrete_line_id,
        concreteLine: line.concrete_line,
      })),
    );
  }

  async getHandStrategy(params: {
    strategy?: string;
    playerCount: number;
    depthBb: number;
    concreteLineId: number;
    holeCards: string;
  }): Promise<HandStrategy | null> {
    const handId = this.getKnownHandId(params.holeCards);
    const context = await this.readDecodedPack(params);
    if (!context) return null;

    const localHandIndex = context.decoded.handIds.indexOf(handId);
    if (localHandIndex === -1) {
      return {
        holeCards: params.holeCards,
        exists: false,
        actions: [],
      };
    }

    return {
      holeCards: params.holeCards,
      exists: true,
      actions: this.getActionsForLocalHand(context, localHandIndex),
    };
  }

  async getHandStrategyOrThrow(params: {
    strategy?: string;
    playerCount: number;
    depthBb: number;
    concreteLineId: number;
    holeCards: string;
  }): Promise<HandStrategy> {
    const result = await this.getHandStrategy(params);
    if (!result) {
      throw new PreflopQueryError("PACK_NOT_FOUND", "Range pack was not found for the requested concrete line.", {
        strategy: params.strategy ?? "default",
        playerCount: params.playerCount,
        depthBb: params.depthBb,
        concreteLineId: params.concreteLineId,
      });
    }

    return result;
  }

  async getHandStrategiesBatch(params: {
    strategy?: string;
    playerCount: number;
    depthBb: number;
    requests: BatchHandStrategyRequest[];
  }): Promise<BatchHandStrategyResult[]> {
    const results: BatchHandStrategyResult[] = [];

    for (const request of params.requests) {
      try {
        results.push({
          ...request,
          strategy: await this.getHandStrategyOrThrow({
            strategy: params.strategy,
            playerCount: params.playerCount,
            depthBb: params.depthBb,
            concreteLineId: request.concreteLineId,
            holeCards: request.holeCards,
          }),
          error: null,
        });
      } catch (error) {
        results.push({
          ...request,
          strategy: null,
          error: toPreflopQueryErrorInfo(error),
        });
      }
    }

    return results;
  }

  async getScenarioHandStrategies(params: {
    strategy?: string;
    drillName: string;
    playerCount: number;
    drillDepth?: number;
    depthBb: number;
    holeCards: string;
  }): Promise<ScenarioHandStrategy[]> {
    const concreteLines = this.getScenarioConcreteLines(params);
    const results: ScenarioHandStrategy[] = [];

    for (const concreteLine of concreteLines) {
      const strategy = await this.getHandStrategyOrThrow({
        strategy: params.strategy,
        playerCount: params.playerCount,
        depthBb: params.depthBb,
        concreteLineId: concreteLine.concreteLineId,
        holeCards: params.holeCards,
      });

      results.push({
        ...concreteLine,
        strategy,
      });
    }

    return results;
  }

  async getFullRange(params: {
    strategy?: string;
    playerCount: number;
    depthBb: number;
    concreteLineId: number;
  }): Promise<HandStrategy[]> {
    const context = await this.readDecodedPack(params);
    if (!context) return [];

    return context.decoded.handIds.map((handId, localHandIndex) => ({
      holeCards: getHandCode(handId),
      exists: true,
      actions: this.getActionsForLocalHand(context, localHandIndex),
    }));
  }

  async getHandsByAction(params: {
    strategy?: string;
    playerCount: number;
    depthBb: number;
    concreteLineId: number;
    actionName: ActionName | string;
    minFrequency?: number;
  }): Promise<Array<{ holeCards: string; frequency: number; handEV: number | null; actionSize: number; amountBB: number }>> {
    const context = await this.readDecodedPack(params);
    if (!context) return [];

    const targetActionName = normalizeActionName(params.actionName);
    const minFrequency = params.minFrequency ?? 0;
    const targetActions = context.actions.filter((action) => action.actionName === targetActionName);
    if (targetActions.length === 0) return [];

    const result: Array<{ holeCards: string; frequency: number; handEV: number | null; actionSize: number; amountBB: number }> = [];
    const actionCount = context.actions.length;

    for (let localHandIndex = 0; localHandIndex < context.decoded.handIds.length; localHandIndex++) {
      const holeCards = getHandCode(context.decoded.handIds[localHandIndex]);

      for (const action of targetActions) {
        const cell = context.decoded.cells[localHandIndex * actionCount + action.actionId];
        if (!cell.exists || cell.frequency <= minFrequency) continue;

        result.push({
          holeCards,
          frequency: cell.frequency,
          handEV: cell.handEV,
          actionSize: action.actionSize,
          amountBB: action.amountBB,
        });
      }
    }

    return result;
  }

  async close(): Promise<void> {
    for (const reader of this.readers.values()) {
      await reader.close();
    }
    this.readers.clear();
    this.packCache.clear();
    this.metaDb.close();
  }

  private async readDecodedPack(params: {
    strategy?: string;
    playerCount: number;
    depthBb: number;
    concreteLineId: number;
  }): Promise<DecodedPackContext | null> {
    const cacheKey = this.getPackCacheKey(params);
    const cached = this.getCachedPack(cacheKey);
    if (cached) return cached;

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

    const decoded = decodeRangePack({
      bytes,
      handCount: packIndex.hand_count,
      actionCount: actions.length,
    });

    const context = { packIndex, actions, decoded };
    this.setCachedPack(cacheKey, context);
    return context;
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

  private async getReader(binFile: string): Promise<RangeBinReader> {
    const cached = this.readers.get(binFile);
    if (cached) return cached;

    const reader = new RangeBinReader(join(this.binaryDir, binFile));
    try {
      await reader.open();
    } catch (error) {
      throw this.toReaderOpenError(error, binFile);
    }
    this.readers.set(binFile, reader);
    return reader;
  }

  private getActionsForLocalHand(context: DecodedPackContext, localHandIndex: number): ActionResult[] {
    const actionCount = context.actions.length;
    const result: ActionResult[] = [];

    for (const action of context.actions) {
      const cell = context.decoded.cells[localHandIndex * actionCount + action.actionId];
      if (!cell.exists) continue;

      result.push({
        actionName: action.actionName,
        actionSize: action.actionSize,
        amountBB: action.amountBB,
        frequency: cell.frequency,
        handEV: cell.handEV,
        exists: true,
      });
    }

    return result;
  }

  private getKnownHandId(holeCards: string): number {
    try {
      return getHandId(holeCards);
    } catch (_error) {
      throw new PreflopQueryError("UNKNOWN_HAND", `Unknown hole cards: ${holeCards}`, { holeCards });
    }
  }

  private getPackCacheKey(params: {
    strategy?: string;
    playerCount: number;
    depthBb: number;
    concreteLineId: number;
  }): string {
    return `${params.strategy ?? "default"}:${params.playerCount}:${params.depthBb}:${params.concreteLineId}`;
  }

  private getCachedPack(cacheKey: string): DecodedPackContext | null {
    const cached = this.packCache.get(cacheKey);
    if (!cached) return null;

    this.packCache.delete(cacheKey);
    this.packCache.set(cacheKey, cached);
    return cached;
  }

  private setCachedPack(cacheKey: string, context: DecodedPackContext): void {
    const maxSize = this.options.packCacheSize ?? 0;
    if (maxSize <= 0) return;

    this.packCache.set(cacheKey, context);
    while (this.packCache.size > maxSize) {
      const oldestKey = this.packCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.packCache.delete(oldestKey);
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

function isErrnoException(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}
