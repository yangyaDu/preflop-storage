import type { ActionName } from "../../binary/action-schema-codec";
import type { PreflopQueryErrorInfo } from "../../query/errors";

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

export interface ActionSchemaRow {
  id: number;
  action_count: number;
  action_blob: Uint8Array;
  checksum: number;
}

export interface RangeStrataQueryServiceOptions {
  verifyChecksums?: boolean;
  prewarmActionSchemas?: boolean;
  /** Maximum number of concurrently open DimensionHandle mmaps. Default 3. */
  maxOpenHandles?: number;
}
