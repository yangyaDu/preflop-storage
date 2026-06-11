export interface RangeCellValue {
  frequency: number;
  handEV: number | null;
}

export interface DecodedCell {
  handId: number;
  actionId: number;
  exists: boolean;
  frequency: number;
  handEV: number | null;
}

export interface DecodedRangePack {
  handIds: number[];
  actionMasks: number[];
  cells: DecodedCell[];
}

/**
 * 在 uint32 掩码中设置指定 actionId 的位为 1。
 * 
 * @param mask 原始的 uint32 掩码数值
 * @param actionId 动作ID (必须在 0 到 31 之间)
 * @returns 设置完相应位后的 32 位无符号整数
 * @throws 当 actionId 超出 [0, 31] 范围时抛出错误
 */
export function setMaskBit(mask: number, actionId: number): number {
  if (actionId < 0 || actionId >= 32) throw new Error(`Invalid action id for uint32 mask: ${actionId}`);
  return (mask | (1 << actionId)) >>> 0;
}

/**
 * 检查 uint32 掩码中指定 actionId 对应的位是否为 1。
 * 
 * @param mask 待检查的 uint32 掩码数值
 * @param actionId 动作ID (必须在 0 到 31 之间)
 * @returns 如果对应位为 1 则返回 true，否则返回 false
 * @throws 当 actionId 超出 [0, 31] 范围时抛出错误
 */
export function hasMaskBit(mask: number, actionId: number): boolean {
  if (actionId < 0 || actionId >= 32) throw new Error(`Invalid action id for uint32 mask: ${actionId}`);
  return ((mask >>> actionId) & 1) === 1;
}

/**
 * 根据起手牌数量和动作数量，计算范围包的预期二进制字节长度。
 * 布局结构：
 * - 所有的 handId：每个占用 1 字节 (共 handCount * 1 字节)
 * - 所有的动作掩码(actionMask)：每个占用 4 字节 (共 handCount * 4 字节)
 * - 所有单元格的数据(frequency + handEV)：每手牌有 actionCount 个单元格，每个单元格占 8 字节(4字节频率 + 4字节 EV)
 *   (共 handCount * actionCount * 8 字节)
 * 总长度 = handCount * (5 + actionCount * 8)
 * 
 * @param handCount 起手牌数量
 * @param actionCount 动作总数量 (最大支持 32 个动作)
 * @returns 预期的字节长度
 * @throws 当动作数量大于 32 时抛出异常（V1版本仅支持最多32个动作）
 */
export function getRangePackByteLength(handCount: number, actionCount: number): number {
  if (actionCount > 32) throw new Error(`V1 range pack supports up to 32 actions, got ${actionCount}`);
  return handCount * (5 + actionCount * 8);
}

/**
 * 将手牌范围数据编码为二进制字节数组 (Uint8Array)。
 * 
 * 写入数据的布局顺序：
 * 1. 依次写入所有起手牌的 handId (每手牌 1 字节)
 * 2. 依次写入所有起手牌的 actionMask (每手牌 4 字节，小端序)
 * 3. 依次写入数据矩阵中所有单元格的值（按手牌主序，即先写入第一手牌的所有动作，再写入第二手牌，以此类推）。
 *    每个单元格占用 8 字节：
 *    - 4 字节：频率 frequency (Float32, 小端序)
 *    - 4 字节：手牌期望值 EV (Float32, 小端序，若无值则存入 NaN)
 * 
 * @param params 编码参数，包括 handIds 列表、动作掩码列表、值矩阵和动作总数
 * @returns 编码后的范围包字节数组
 * @throws 当参数长度不一致，或者手牌ID超出合法范围时抛出错误
 */
export function encodeRangePack(params: {
  handIds: number[];
  actionMasks: number[];
  values: RangeCellValue[][];
  actionCount: number;
}): Uint8Array {
  const { handIds, actionMasks, values, actionCount } = params;
  const handCount = handIds.length;

  if (actionMasks.length !== handCount) {
    throw new Error(`Invalid action mask count: expected ${handCount}, got ${actionMasks.length}`);
  }
  if (values.length !== handCount) {
    throw new Error(`Invalid value row count: expected ${handCount}, got ${values.length}`);
  }

  const byteLength = getRangePackByteLength(handCount, actionCount);
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = 0;

  for (const handId of handIds) {
    if (handId < 0 || handId > 168) throw new Error(`Invalid hand id: ${handId}`);
    view.setUint8(cursor, handId);
    cursor += 1;
  }

  for (const mask of actionMasks) {
    view.setUint32(cursor, mask >>> 0, true);
    cursor += 4;
  }

  for (let handIndex = 0; handIndex < handCount; handIndex++) {
    const row = values[handIndex];
    if (row.length !== actionCount) {
      throw new Error(`Invalid action value count at hand index ${handIndex}: expected ${actionCount}, got ${row.length}`);
    }

    for (let actionId = 0; actionId < actionCount; actionId++) {
      const cell = row[actionId];
      view.setFloat32(cursor, cell.frequency, true);
      cursor += 4;

      view.setFloat32(cursor, cell.handEV ?? Number.NaN, true);
      cursor += 4;
    }
  }

  return bytes;
}

/**
 * 解码二进制字节流中的范围数据包。
 * 
 * @param params 解码参数，包含二进制字节数组、手牌总数和动作总数
 * @returns 解码后的结构，包括 handIds、actionMasks 以及展平后的单元格列表 (cells)
 * @throws 当二进制字节流的实际长度不等于预期长度时抛出错误
 */
export function decodeRangePack(params: {
  bytes: Uint8Array;
  handCount: number;
  actionCount: number;
}): DecodedRangePack {
  const { bytes, handCount, actionCount } = params;
  const expectedLength = getRangePackByteLength(handCount, actionCount);
  if (bytes.byteLength !== expectedLength) {
    throw new Error(`Invalid pack length: expected ${expectedLength}, got ${bytes.byteLength}`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = 0;

  const handIds: number[] = [];
  for (let handIndex = 0; handIndex < handCount; handIndex++) {
    handIds.push(view.getUint8(cursor));
    cursor += 1;
  }

  const actionMasks: number[] = [];
  for (let handIndex = 0; handIndex < handCount; handIndex++) {
    actionMasks.push(view.getUint32(cursor, true));
    cursor += 4;
  }

  const cells: DecodedCell[] = [];
  for (let handIndex = 0; handIndex < handCount; handIndex++) {
    for (let actionId = 0; actionId < actionCount; actionId++) {
      const frequency = view.getFloat32(cursor, true);
      cursor += 4;

      const rawHandEV = view.getFloat32(cursor, true);
      cursor += 4;

      cells.push({
        handId: handIds[handIndex],
        actionId,
        exists: hasMaskBit(actionMasks[handIndex], actionId),
        frequency,
        handEV: Number.isNaN(rawHandEV) ? null : rawHandEV,
      });
    }
  }

  return { handIds, actionMasks, cells };
}
