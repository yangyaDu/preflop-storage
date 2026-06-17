import { PreflopStoreError } from "../query/errors";

export const RANGE_FILE_MAGIC = "PFSP";
export const RANGE_FILE_VERSION = 1;
export const RANGE_FILE_HEADER_SIZE = 16;

export interface RangeFileHeader {
  magic: string;
  version: number;
  endian: number;
  floatType: number;
  layout: number;
  compression: number;
  headerSize: number;
}

/**
 * 编码并生成范围数据文件 (ranges.bin) 的文件头字节数组。
 * 文件头大小固定为 16 字节：
 * - 0-3 字节：魔数 "PFSP" (Preflop Storage Pack)
 * - 4-5 字节：版本号 (RANGE_FILE_VERSION = 1, 小端序)
 * - 6 字节：字节序 (1 = 小端序)
 * - 7 字节：浮点数格式 (1 = Float32)
 * - 8 字节：数据布局方式 (1 = sparse hand-major v1)
 * - 9 字节：压缩方式 (0 = 无压缩)
 * - 10-11 字节：文件头大小 (RANGE_FILE_HEADER_SIZE = 16, 小端序)
 * 
 * @returns 编码后的 16 字节 Uint8Array 文件头
 */
export function encodeFileHeader(): Uint8Array {
  const bytes = new Uint8Array(RANGE_FILE_HEADER_SIZE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  view.setUint8(0, "P".charCodeAt(0));
  view.setUint8(1, "F".charCodeAt(0));
  view.setUint8(2, "S".charCodeAt(0));
  view.setUint8(3, "P".charCodeAt(0));
  view.setUint16(4, RANGE_FILE_VERSION, true);
  view.setUint8(6, 1);
  view.setUint8(7, 1);
  view.setUint8(8, 1);
  view.setUint8(9, 0);
  view.setUint16(10, RANGE_FILE_HEADER_SIZE, true);

  return bytes;
}

/**
 * 解码二进制字节流中的 ranges.bin 文件头。
 * 
 * @param bytes 包含文件头数据的字节数组
 * @returns 解析后的 RangeFileHeader 结构体对象
 * @throws 当输入字节流长度不足 16 字节时抛出错误
 */
export function decodeFileHeader(bytes: Uint8Array): RangeFileHeader {
  if (bytes.byteLength < RANGE_FILE_HEADER_SIZE) {
    throw new PreflopStoreError("INVALID_FORMAT", `Invalid ranges.bin header length: ${bytes.byteLength}`, { expected: RANGE_FILE_HEADER_SIZE, got: bytes.byteLength });
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));

  return {
    magic,
    version: view.getUint16(4, true),
    endian: view.getUint8(6),
    floatType: view.getUint8(7),
    layout: view.getUint8(8),
    compression: view.getUint8(9),
    headerSize: view.getUint16(10, true),
  };
}

/**
 * 校验文件头信息是否为当前代码所支持的格式。
 * 
 * @param header 解码出的 RangeFileHeader 对象
 * @throws 当检测到魔数错误、不支持的版本、大端序、非Float32、非指定布局、已压缩或头部大小错误时抛出异常
 */
export function assertSupportedHeader(header: RangeFileHeader): void {
  if (header.magic !== RANGE_FILE_MAGIC) throw new PreflopStoreError("INVALID_FORMAT", `Invalid ranges.bin magic: ${header.magic}`, { expected: RANGE_FILE_MAGIC, got: header.magic });
  if (header.version !== RANGE_FILE_VERSION) throw new PreflopStoreError("UNSUPPORTED_DATA_VERSION", `Unsupported PFSP version: ${header.version}`, { expected: RANGE_FILE_VERSION, got: header.version });
  if (header.endian !== 1) throw new PreflopStoreError("INVALID_FORMAT", "Unsupported endian, expected little-endian");
  if (header.floatType !== 1) throw new PreflopStoreError("INVALID_FORMAT", "Unsupported float type, expected float32");
  if (header.layout !== 1) throw new PreflopStoreError("INVALID_FORMAT", "Unsupported layout, expected sparse hand-major v1");
  if (header.compression !== 0) throw new PreflopStoreError("INVALID_FORMAT", "Unsupported compression, expected none");
  if (header.headerSize !== RANGE_FILE_HEADER_SIZE) {
    throw new PreflopStoreError("INVALID_FORMAT", `Unsupported header size: ${header.headerSize}`, { expected: RANGE_FILE_HEADER_SIZE, got: header.headerSize });
  }
}
