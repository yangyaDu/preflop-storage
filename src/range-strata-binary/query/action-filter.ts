import { join } from "node:path";
import { normalizeActionName } from "../../binary/action-schema-codec";
import { assertCrc32c } from "../../binary/crc32c";
import { RangeBinFileReader } from "../../binary/range-bin-file-reader";
import { decodeRangePackForHand, decodeRangePackMaskMatch } from "../../binary/range-pack-codec";
import { getHandCode } from "../../hand/hand-dict";
import { getBinFileName } from "../../db/naming";
import { PreflopQueryError } from "../../query/errors";
import { getIdxFileName } from "../catalog/naming";
import { RangeIdxReader } from "../index/reader";
import { ActionSchemaCache } from "./action-schema-cache";

export interface HandsByActionQuery {
  strategy?: string;
  playerCount: number;
  depthBb: number;
  concreteLineId: number;
  actionNames?: string[];
  minFrequency?: number;
}

export async function getHandsByActionFromStore(params: {
  binaryDir: string;
  verifyChecksums?: boolean;
  actionSchemas: ActionSchemaCache;
  query: HandsByActionQuery;
}): Promise<string[]> {
  const { binaryDir, verifyChecksums, actionSchemas, query } = params;
  const strategy = query.strategy ?? "default";
  const idxFileName = getIdxFileName(strategy, query.playerCount, query.depthBb);
  const binFileName = getBinFileName(strategy, query.playerCount, query.depthBb);
  const idxPath = join(binaryDir, idxFileName);
  const binPath = join(binaryDir, binFileName);
  const idxReader = new RangeIdxReader(idxPath);
  await idxReader.open();

  try {
    const idxRecord = idxReader.find(query.concreteLineId);
    if (!idxRecord) return [];

    const binReader = new RangeBinFileReader(binPath);
    binReader.open();

    let bytes: Uint8Array;
    try {
      bytes = binReader.read(idxRecord.offset, idxRecord.byteLength);
    } finally {
      binReader.close();
    }

    if (verifyChecksums) {
      try {
        assertCrc32c(bytes, idxRecord.checksum);
      } catch (error) {
        throw new PreflopQueryError("CHECKSUM_MISMATCH", error instanceof Error ? error.message : String(error), {
          concreteLineId: query.concreteLineId,
          expectedChecksum: idxRecord.checksum,
        });
      }
    }

    const actions = actionSchemas.get(idxRecord.actionSchemaId);
    const targetActionNames = query.actionNames;
    const minFrequency = query.minFrequency ?? 0;

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
          const cell = cells.find((candidate) => candidate.actionId === actionId);
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
