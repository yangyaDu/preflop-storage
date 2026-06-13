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

/**
 * 按需解码：只解析指定 handId 的策略数据。
 *
 * 与 decodeRangePack 全量解码的对比：
 * - 全量：读 845 字节 → 分配 169 handIds + 169 masks + 1690 cells
 * - 按需：读 845 字节 → 直接访问 Uint8Array 找 handId → 只解码目标手牌 ~10 cell
 *
 * 使用直接 TypedArray 访问替代 DataView，避免 per-byte 方法调用开销。
 *
 * @param params 解码参数（bytes、handCount、actionCount），外加目标 handId
 * @returns 目标手牌的单元格数组，若未找到返回空数组
 */
export function decodeRangePackForHand(params: {
  bytes: Uint8Array;
  handCount: number;
  actionCount: number;
  targetHandId: number;
}): DecodedCell[] {
  const { bytes, handCount, actionCount, targetHandId } = params;
  const expectedLength = getRangePackByteLength(handCount, actionCount);
  if (bytes.byteLength !== expectedLength) {
    throw new Error(`Invalid pack length: expected ${expectedLength}, got ${bytes.byteLength}`);
  }

  // 步骤 1：二分查找 handId（handIds 按升序排列，最多 169 个）
  let lo = 0;
  let hi = handCount - 1;
  let localHandIndex = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const val = bytes[mid];
    if (val < targetHandId) { lo = mid + 1; }
    else if (val > targetHandId) { hi = mid - 1; }
    else { localHandIndex = mid; break; }
  }
  if (localHandIndex === -1) return [];

  // 步骤 2：通过 Uint32Array 或 DataView 读取 actionMask（masks 在 handIds 之后）
  const maskOffset = handCount;
  const maskByteOffset = bytes.byteOffset + maskOffset;
  const maskAligned = maskByteOffset % 4 === 0;
  let mask: number;
  if (maskAligned) {
    const maskView = new Uint32Array(bytes.buffer, maskByteOffset, handCount);
    mask = maskView[localHandIndex];
  } else {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    mask = view.getUint32(maskOffset + localHandIndex * 4, true);
  }

  // 步骤 3：通过 Float32Array 或 DataView 读取 cell 数据
  const cellsStart = handCount + handCount * 4;
  const floatsPerHand = actionCount * 2;
  const cellByteOffset = cellsStart + localHandIndex * floatsPerHand * 4;
  // 检查 cell 数据起始是否 float32 对齐（4 字节）
  const absoluteCellOffset = bytes.byteOffset + cellByteOffset;
  const cellsAligned = absoluteCellOffset % 4 === 0;

  const cells: DecodedCell[] = [];

  if (cellsAligned) {
    const floatCount = handCount * floatsPerHand;
    const values = new Float32Array(bytes.buffer, absoluteCellOffset, floatCount);
    const baseIndex = localHandIndex * floatsPerHand;
    for (let actionId = 0; actionId < actionCount; actionId++) {
      const idx = baseIndex + actionId * 2;
      cells.push({
        handId: targetHandId,
        actionId,
        exists: hasMaskBit(mask, actionId),
        frequency: values[idx],
        handEV: Number.isNaN(values[idx + 1]) ? null : values[idx + 1],
      });
    }
  } else {
    const cellView = new DataView(bytes.buffer, bytes.byteOffset + cellByteOffset, actionCount * 8);
    for (let actionId = 0; actionId < actionCount; actionId++) {
      const cellOffset = actionId * 8;
      const frequency = cellView.getFloat32(cellOffset, true);
      const rawHandEV = cellView.getFloat32(cellOffset + 4, true);
      cells.push({
        handId: targetHandId,
        actionId,
        exists: hasMaskBit(mask, actionId),
        frequency,
        handEV: Number.isNaN(rawHandEV) ? null : rawHandEV,
      });
    }
  }

  return cells;
}

/**
 * 零分配解码：直接使用 buffer + offset 访问，不通过 subarray 创建中间 Uint8Array。
 *
 * 二分定位 targetHandId → 读取 mask → 只解码目标手牌的 cell 数据。
 * 返回紧凑的 `{ actionId, frequency, handEV }` 数组，仅包含存在的 cell。
 *
 * @param buffer 整个 .bin 文件的 ArrayBuffer
 * @param packByteOffset pack 在 buffer 中的起始偏移
 * @param handCount pack 中的手牌数
 * @param actionCount pack 中的 action 数
 * @param targetHandId 目标手牌 ID
 * @returns 存在的 cell 数组（空数组表示 hand 不在 pack 中）
 */
export function decodeRangePackForHandDirect(params: {
  buffer: ArrayBufferLike;
  packByteOffset: number;
  handCount: number;
  actionCount: number;
  targetHandId: number;
}): Array<{ actionId: number; frequency: number; handEV: number | null }> {
  const { buffer, packByteOffset, handCount, actionCount, targetHandId } = params;

  // 步骤 1：二分查找 handId
  const handIdView = new Uint8Array(buffer, packByteOffset, handCount);
  let lo = 0;
  let hi = handCount - 1;
  let localHandIndex = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const val = handIdView[mid];
    if (val < targetHandId) { lo = mid + 1; }
    else if (val > targetHandId) { hi = mid - 1; }
    else { localHandIndex = mid; break; }
  }
  if (localHandIndex === -1) return [];

  // 步骤 2：读取 actionMask（handIds 之后，按 handIndex * 4 偏移）
  const maskOffset = packByteOffset + handCount + localHandIndex * 4;
  const maskView = new DataView(buffer, maskOffset, 4);
  const mask = maskView.getUint32(0, true);

  // 步骤 3：只读取目标手牌的 cell 数据
  // handIds 是 1 字节 uint8，所以 cell 段起始可能不是 4 字节对齐，需分两路
  const cellsStart = handCount + handCount * 4;
  const floatsPerHand = actionCount * 2;
  const cellByteOffset = packByteOffset + cellsStart + localHandIndex * floatsPerHand * 4;
  const cellsAligned = cellByteOffset % 4 === 0;

  const result: Array<{ actionId: number; frequency: number; handEV: number | null }> = [];

  if (cellsAligned) {
    const cellView = new Float32Array(buffer, cellByteOffset, floatsPerHand);
    for (let actionId = 0; actionId < actionCount; actionId++) {
      if (((mask >>> actionId) & 1) === 0) continue;
      const idx = actionId * 2;
      const handEV = cellView[idx + 1];
      result.push({
        actionId,
        frequency: cellView[idx],
        handEV: Number.isNaN(handEV) ? null : handEV,
      });
    }
  } else {
    const cellView = new DataView(buffer, cellByteOffset, floatsPerHand * 4);
    for (let actionId = 0; actionId < actionCount; actionId++) {
      if (((mask >>> actionId) & 1) === 0) continue;
      const cellOffset = actionId * 8;
      const frequency = cellView.getFloat32(cellOffset, true);
      const rawHandEV = cellView.getFloat32(cellOffset + 4, true);
      result.push({
        actionId,
        frequency,
        handEV: Number.isNaN(rawHandEV) ? null : rawHandEV,
      });
    }
  }

  return result;
}

/**
 * 掩码匹配：只解析 handIds 和 actionMasks，按 targetActionIds 匹配，
 * 返回匹配的手牌 ID 列表（不解析 cell 数据段）。
 *
 * 使用直接 TypedArray 访问替代 DataView，避免 per-byte 方法调用开销。
 *
 * @param params 解码参数（bytes、handCount、actionCount），外加 targetActionIds
 * @returns 匹配的手牌 handId 数组
 */
export function decodeRangePackMaskMatch(params: {
  bytes: Uint8Array;
  handCount: number;
  actionCount: number;
  targetActionIds: number[];
}): number[] {
  const { bytes, handCount, actionCount, targetActionIds } = params;
  const expectedLength = getRangePackByteLength(handCount, actionCount);
  if (bytes.byteLength !== expectedLength) {
    throw new Error(`Invalid pack length: expected ${expectedLength}, got ${bytes.byteLength}`);
  }

  if (targetActionIds.length === 0) {
    // 空条件 = 匹配所有手牌
    const handIds: number[] = [];
    for (let i = 0; i < handCount; i++) {
      handIds.push(bytes[i]);
    }
    return handIds;
  }

  // 计算目标掩码：所有 targetActionIds 的位都要置1
  let targetMask = 0;
  for (const actionId of targetActionIds) {
    targetMask = setMaskBit(targetMask, actionId);
  }

  // 通过 Uint32Array 或 DataView 读取 actionMasks
  const maskOffset = handCount;
  const maskByteOffset = bytes.byteOffset + maskOffset;
  const maskAligned = maskByteOffset % 4 === 0;
  const result: number[] = [];

  if (maskAligned) {
    const maskView = new Uint32Array(bytes.buffer, maskByteOffset, handCount);
    for (let handIndex = 0; handIndex < handCount; handIndex++) {
      if ((maskView[handIndex] & targetMask) === targetMask) {
        result.push(bytes[handIndex]);
      }
    }
  } else {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let handIndex = 0; handIndex < handCount; handIndex++) {
      if ((view.getUint32(maskOffset + handIndex * 4, true) & targetMask) === targetMask) {
        result.push(bytes[handIndex]);
      }
    }
  }

  return result;
}
