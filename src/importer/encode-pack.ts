import { compareActionDefs, encodeActionSchema, normalizeActionName, type ActionDef } from "../binary/action-schema-codec";
import { encodeRangePack, setMaskBit, type RangeCellValue } from "../binary/range-pack-codec";
import { getHandId } from "../hand/hand-dict";
import { type OldRangeRow } from "./old-sqlite";

export interface EncodedConcreteLinePack {
  actionBlob: Uint8Array;
  actionCount: number;
  handCount: number;
  payload: Uint8Array;
}

export function encodeConcreteLinePack(rows: OldRangeRow[]): EncodedConcreteLinePack {
  if (rows.length === 0) throw new Error("Cannot encode empty concrete line range pack");

  const actionByKey = new Map<string, Pick<ActionDef, "actionName" | "actionSize" | "amountBB">>();
  const handIds = [...new Set(rows.map((row) => getHandId(row.hole_cards)))].sort((left, right) => left - right);

  for (const row of rows) {
    const actionName = normalizeActionName(row.action_name);
    const actionSize = Number(row.action_size);
    const amountBB = Number(row.amount_bb);
    actionByKey.set(actionKey(actionName, actionSize, amountBB), { actionName, actionSize, amountBB });
  }

  const actions = [...actionByKey.values()].sort(compareActionDefs).map((action, actionId) => ({
    actionId,
    ...action,
  }));
  if (actions.length > 32) {
    throw new Error(`V1 range pack supports up to 32 actions, got ${actions.length}`);
  }

  const actionIdByKey = new Map(actions.map((action) => [actionKey(action.actionName, action.actionSize, action.amountBB), action.actionId]));
  const handIndexById = new Map(handIds.map((handId, handIndex) => [handId, handIndex]));
  const actionMasks = new Array<number>(handIds.length).fill(0);
  const values: RangeCellValue[][] = handIds.map(() =>
    actions.map(() => ({
      frequency: 0,
      handEV: null,
    })),
  );

  for (const row of rows) {
    const handId = getHandId(row.hole_cards);
    const handIndex = handIndexById.get(handId);
    if (handIndex === undefined) throw new Error(`Internal hand index mismatch for ${row.hole_cards}`);

    const normalizedActionName = normalizeActionName(row.action_name);
    const actionId = actionIdByKey.get(actionKey(normalizedActionName, Number(row.action_size), Number(row.amount_bb)));
    if (actionId === undefined) throw new Error(`Internal action index mismatch for ${row.action_name}`);

    actionMasks[handIndex] = setMaskBit(actionMasks[handIndex], actionId);
    values[handIndex][actionId] = {
      frequency: Number(row.frequency),
      handEV: row.hand_ev === null || row.hand_ev === undefined ? null : Number(row.hand_ev),
    };
  }

  const actionBlob = encodeActionSchema(actions);
  const payload = encodeRangePack({
    handIds,
    actionMasks,
    values,
    actionCount: actions.length,
  });

  return {
    actionBlob,
    actionCount: actions.length,
    handCount: handIds.length,
    payload,
  };
}

export function actionKey(actionName: string, actionSize: number, amountBB: number): string {
  return `${actionName}\0${actionSize}\0${amountBB}`;
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex");
}
