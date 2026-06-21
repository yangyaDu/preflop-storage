import {
  PreflopQueryError,
  PreflopStoreError,
  toPreflopQueryErrorInfo,
  type PreflopQueryErrorInfo,
} from "../../query/errors";
import { ActionSchemaCache } from "./action-schema-cache";
import type {
  ActionResult,
  BatchHandStrategyRequest,
  BatchHandStrategyResult,
  HandStrategy,
} from "./types";

// Flat buffer protocol constants for query_batch_flat
const FLAT_MAGIC = 0x46425146; // "FQBF"
const FLAT_CELL_SIZE = 21;

export function toBatchFatalErrorResults(
  requests: BatchHandStrategyRequest[],
  invalidHandErrors: Map<number, PreflopQueryErrorInfo>,
  error: unknown,
): BatchHandStrategyResult[] {
  const fatalError = toPreflopQueryErrorInfo(error, "INVALID_FORMAT");
  return requests.map((request, index) => ({
    ...request,
    strategy: null,
    error: invalidHandErrors.get(index) ?? fatalError,
  }));
}

export function parseFlatBatchResult(params: {
  rawBuffer: unknown;
  requests: BatchHandStrategyRequest[];
  requestIndexes: number[];
  invalidHandErrors: Map<number, PreflopQueryErrorInfo>;
  actionSchemas: ActionSchemaCache;
}): BatchHandStrategyResult[] {
  const { rawBuffer, requests, requestIndexes, invalidHandErrors, actionSchemas } = params;
  const flat = normalizeFlatBatchBuffer(rawBuffer);
  const view = new DataView(flat.buffer, flat.byteOffset, flat.byteLength);
  let offset = 0;

  assertFlatBytesAvailable(flat, offset, 12, "header");
  const magic = view.getUint32(offset, true);
  if (magic !== FLAT_MAGIC) {
    throw new PreflopStoreError("INVALID_FORMAT", `Invalid flat buffer magic: 0x${magic.toString(16)}`, {
      expected: FLAT_MAGIC,
      got: magic,
    });
  }
  offset += 4;
  const requestCount = view.getUint32(offset, true);
  offset += 4;
  /* hitCount = */ offset += 4;
  if (requestCount !== requestIndexes.length) {
    throw new PreflopStoreError("INVALID_FORMAT", `Flat buffer request count mismatch: expected ${requestIndexes.length}, got ${requestCount}`, {
      expected: requestIndexes.length,
      got: requestCount,
    });
  }

  assertFlatBytesAvailable(flat, offset, requestCount * 8, "per-request table");
  const perRequestMeta: { cellCount: number; schemaId: number }[] = [];
  let totalCellCount = 0;
  for (let i = 0; i < requestCount; i++) {
    const cellCount = view.getUint16(offset, true);
    offset += 2;
    /* reserved = */ offset += 2;
    const schemaId = view.getUint32(offset, true);
    offset += 4;
    perRequestMeta.push({ cellCount, schemaId });
    totalCellCount += cellCount;
  }
  assertFlatBytesAvailable(flat, offset, totalCellCount * FLAT_CELL_SIZE, "cell data");

  for (const { cellCount, schemaId } of perRequestMeta) {
    if (cellCount > 0) {
      actionSchemas.get(schemaId);
    }
  }

  const resultByIndex = new Map<number, HandStrategy | null>();

  for (let i = 0; i < requestCount; i++) {
    const originalIdx = requestIndexes[i];
    const { cellCount, schemaId } = perRequestMeta[i];

    if (cellCount === 0) {
      resultByIndex.set(originalIdx, null);
      continue;
    }

    const actions = actionSchemas.getCached(schemaId);
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

  if (offset !== flat.byteLength) {
    throw new PreflopStoreError("INVALID_FORMAT", "Flat batch buffer has trailing bytes", {
      parsedBytes: offset,
      bufferBytes: flat.byteLength,
    });
  }

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

function normalizeFlatBatchBuffer(rawBuffer: unknown): Uint8Array {
  if (rawBuffer instanceof Uint8Array) return rawBuffer;
  if (rawBuffer instanceof ArrayBuffer) return new Uint8Array(rawBuffer);

  const arrayLike = asArrayLike(rawBuffer);
  if (!arrayLike) {
    throw new PreflopStoreError("INVALID_FORMAT", "queryBatchFlat returned a non-byte-buffer value", {
      valueType: typeof rawBuffer,
    });
  }

  const flat = new Uint8Array(arrayLike.length);
  for (let i = 0; i < arrayLike.length; i++) {
    const byte = arrayLike[i];
    if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new PreflopStoreError("INVALID_FORMAT", `queryBatchFlat returned an invalid byte at offset ${i}`, {
        offset: i,
        value: typeof byte === "number" ? byte : String(byte),
      });
    }
    flat[i] = byte;
  }
  return flat;
}

function asArrayLike(value: unknown): ArrayLike<unknown> | null {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return null;

  const maybeArrayLike = value as { length?: unknown };
  const length = maybeArrayLike.length;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return null;
  return value as ArrayLike<unknown>;
}

function assertFlatBytesAvailable(flat: Uint8Array, offset: number, byteLength: number, section: string): void {
  if (offset + byteLength <= flat.byteLength) return;

  throw new PreflopStoreError("INVALID_FORMAT", `Flat batch buffer is truncated while reading ${section}`, {
    offset,
    requiredBytes: byteLength,
    bufferBytes: flat.byteLength,
  });
}
