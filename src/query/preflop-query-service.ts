import { join } from "node:path";
import { decodeActionSchema, normalizeActionName, type ActionDef, type ActionName } from "../binary/action-schema-codec";
import { assertCrc32c } from "../binary/crc32c";
import { RangeBinReader } from "../binary/range-bin-reader";
import { decodeRangePack, type DecodedRangePack } from "../binary/range-pack-codec";
import { MetaDb, type RangePackIndexRow } from "../db/meta-db";
import { getHandCode, getHandId } from "../hand/hand-dict";

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

interface DecodedPackContext {
  packIndex: RangePackIndexRow;
  actions: ActionDef[];
  decoded: DecodedRangePack;
}

export class PreflopQueryService {
  private readonly metaDb: MetaDb;
  private readonly readers = new Map<string, RangeBinReader>();
  private readonly actionCache = new Map<number, ActionDef[]>();

  constructor(
    metaDbPath: string,
    private readonly binaryDir: string,
    private readonly options: { verifyChecksums?: boolean } = {},
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
    const handId = getHandId(params.holeCards);
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
    this.metaDb.close();
  }

  private async readDecodedPack(params: {
    strategy?: string;
    playerCount: number;
    depthBb: number;
    concreteLineId: number;
  }): Promise<DecodedPackContext | null> {
    const packIndex = this.metaDb.getRangePackIndex(params);
    if (!packIndex) return null;

    const actions = this.getActionSchema(packIndex.action_schema_id);
    const reader = await this.getReader(packIndex.bin_file);
    const bytes = await reader.read(packIndex.offset, packIndex.byte_length);

    if (this.options.verifyChecksums) {
      assertCrc32c(bytes, packIndex.checksum);
    }

    const decoded = decodeRangePack({
      bytes,
      handCount: packIndex.hand_count,
      actionCount: actions.length,
    });

    return { packIndex, actions, decoded };
  }

  private getActionSchema(actionSchemaId: number): ActionDef[] {
    const cached = this.actionCache.get(actionSchemaId);
    if (cached) return cached;

    const schemaRow = this.metaDb.getActionSchema(actionSchemaId);
    if (!schemaRow) throw new Error(`Missing action schema: ${actionSchemaId}`);

    const actions = decodeActionSchema(schemaRow.action_blob, schemaRow.action_count);
    this.actionCache.set(actionSchemaId, actions);
    return actions;
  }

  private async getReader(binFile: string): Promise<RangeBinReader> {
    const cached = this.readers.get(binFile);
    if (cached) return cached;

    const reader = new RangeBinReader(join(this.binaryDir, binFile));
    await reader.open();
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
}
