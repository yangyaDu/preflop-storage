import { PreflopStoreError } from "../query/errors";

export type ActionName = "fold" | "call" | "check" | "bet" | "raise" | "allin";

export interface ActionDef {
  actionId: number;
  actionName: ActionName;
  actionSize: number;
  amountBB: number;
}

export const ACTION_NAME_BY_TYPE: Record<number, ActionName> = {
  0: "fold",
  1: "call",
  2: "check",
  3: "bet",
  4: "raise",
  5: "allin",
};

export const ACTION_TYPE_BY_NAME: Record<ActionName, number> = {
  fold: 0,
  call: 1,
  check: 2,
  bet: 3,
  raise: 4,
  allin: 5,
};

/**
 * 规范化动作名称字符串。
 * 去除首尾空格、转换为小写，并移除所有连字符（-）和下划线（_）。
 * 支持的动作名称包括: "fold", "call", "check", "bet", "raise", "allin"。
 * 
 * @param value 原始动作名称字符串
 * @returns 规范化后的 ActionName
 * @throws 当遇到未知的动作名称时抛出错误
 */
export function normalizeActionName(value: string): ActionName {
  const normalized = value.trim().toLowerCase().replaceAll("-", "").replaceAll("_", "");
  if (normalized === "fold") return "fold";
  if (normalized === "call") return "call";
  if (normalized === "check") return "check";
  if (normalized === "bet") return "bet";
  if (normalized === "raise") return "raise";
  if (normalized === "allin") return "allin";
  throw new PreflopStoreError("INVALID_ARGUMENT", `Unknown action name: ${value}`, { value });
}

/**
 * 比较两个动作定义的排序优先级。
 * 排序逻辑依次为：
 * 1. 动作类型的预定义顺序 (fold < call < check < bet < raise < allin)
 * 2. 动作大小 (actionSize) 升序
 * 3. 筹码量 (amountBB) 升序
 * 
 * @param left 第一个动作（只包含排序需要的字段）
 * @param right 第二个动作（只包含排序需要的字段）
 * @returns 负数表示 left 排在 right 前面，正数表示排在后面，0 表示相等
 */
export function compareActionDefs(left: Pick<ActionDef, "actionName" | "actionSize" | "amountBB">, right: Pick<ActionDef, "actionName" | "actionSize" | "amountBB">): number {
  const typeDiff = ACTION_TYPE_BY_NAME[left.actionName] - ACTION_TYPE_BY_NAME[right.actionName];
  if (typeDiff !== 0) return typeDiff;

  const sizeDiff = left.actionSize - right.actionSize;
  if (sizeDiff !== 0) return sizeDiff;

  return left.amountBB - right.amountBB;
}

/**
 * 将动作架构编码为二进制字节数组。
 * 每个动作占用 9 字节空间：
 * - 1 字节：动作类型 (0-5)
 * - 4 字节：动作大小 (Float32, 小端序)
 * - 4 字节：下注筹码量 BB (Float32, 小端序)
 * 
 * @param actions 要编码的动作定义列表
 * @returns 编码后的 Uint8Array 二进制数据
 */
export function encodeActionSchema(actions: ReadonlyArray<Pick<ActionDef, "actionName" | "actionSize" | "amountBB">>): Uint8Array {
  const bytes = new Uint8Array(actions.length * 9);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = 0;

  for (const action of actions) {
    view.setUint8(cursor, ACTION_TYPE_BY_NAME[action.actionName]);
    cursor += 1;

    view.setFloat32(cursor, action.actionSize, true);
    cursor += 4;

    view.setFloat32(cursor, action.amountBB, true);
    cursor += 4;
  }

  return bytes;
}

/**
 * 解码二进制字节流中的动作架构。
 * 
 * @param actionBlob 二进制动作架构数据
 * @param actionCount 动作的总数量
 * @returns 解码后的 ActionDef 数组，包含自动生成的 actionId (即数组索引)
 * @throws 当数据长度与预期长度不符，或者遇到未知的动作类型时抛出异常
 */
export function decodeActionSchema(actionBlob: Uint8Array, actionCount: number): ActionDef[] {
  const expectedLength = actionCount * 9;
  if (actionBlob.byteLength !== expectedLength) {
    throw new PreflopStoreError("INVALID_FORMAT", `Invalid action schema length: expected ${expectedLength}, got ${actionBlob.byteLength}`, { expected: expectedLength, got: actionBlob.byteLength });
  }

  const view = new DataView(actionBlob.buffer, actionBlob.byteOffset, actionBlob.byteLength);
  const actions: ActionDef[] = [];
  let cursor = 0;

  for (let actionId = 0; actionId < actionCount; actionId++) {
    const type = view.getUint8(cursor);
    cursor += 1;

    const actionSize = view.getFloat32(cursor, true);
    cursor += 4;

    const amountBB = view.getFloat32(cursor, true);
    cursor += 4;

    const actionName = ACTION_NAME_BY_TYPE[type];
    if (!actionName) throw new PreflopStoreError("INVALID_FORMAT", `Unknown action type: ${type}`, { type });

    actions.push({ actionId, actionName, actionSize, amountBB });
  }

  return actions;
}
