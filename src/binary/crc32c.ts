import { PreflopStoreError } from "../query/errors";

const CRC32C_POLY = 0x82f63b78;

const CRC32C_TABLE = new Uint32Array(256);

for (let i = 0; i < CRC32C_TABLE.length; i++) {
  let crc = i;
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc & 1) !== 0 ? (CRC32C_POLY ^ (crc >>> 1)) >>> 0 : crc >>> 1;
  }
  CRC32C_TABLE[i] = crc >>> 0;
}

/**
 * 计算给定字节数组的 CRC32C (Castagnoli) 校验和。
 * 使用 0x82f63b78 作为多项式进行快速查表法计算。
 * 
 * @param bytes 输入的字节数组
 * @returns 32位无符号整数形式的 CRC32C 校验和
 */
export function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc = (CRC32C_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0;
  }

  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 校验给定字节数组的 CRC32C 校验和是否符合预期。
 * 
 * @param bytes 输入的字节数组
 * @param expected 预期的 CRC32C 校验和
 * @throws 当实际计算的校验和与预期不一致时抛出 Error
 */
export function assertCrc32c(bytes: Uint8Array, expected: number): void {
  const actual = crc32c(bytes);
  if (actual !== (expected >>> 0)) {
    throw new PreflopStoreError("INVALID_FORMAT", `CRC32C mismatch: expected ${expected >>> 0}, got ${actual}`, { expected: expected >>> 0, got: actual });
  }
}
