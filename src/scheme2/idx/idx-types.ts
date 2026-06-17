import { PreflopStoreError } from "../../query/errors";

export const IDX_MAGIC = "PFXI";
export const IDX_HEADER_SIZE = 16;
export const IDX_RECORD_SIZE = 22;

/**
 * IdxRecord — 一条 .idx 记录将 concreteLineId 及其 .bin payload 的
 * physical position（offset/byteLength/checksum）关联起来。
 *
 * 记录在 .idx 文件中按 concreteLineId 升序存储，因此可在运行时以
 * O(log n) 进行二分查找。
 */
export interface IdxRecord {
  concreteLineId: number;
  actionSchemaId: number;
  handCount: number;
  offset: number;
  byteLength: number;
  checksum: number;
}

export interface IdxHeader {
  magic: string;
  version: number;
  recordCount: number;
  headerSize: number;
}

export function encodeIdxHeader(recordCount: number): Uint8Array {
  const bytes = new Uint8Array(IDX_HEADER_SIZE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  view.setUint8(0, "P".charCodeAt(0));
  view.setUint8(1, "F".charCodeAt(0));
  view.setUint8(2, "X".charCodeAt(0));
  view.setUint8(3, "I".charCodeAt(0));
  view.setUint16(4, 1, true); // version
  view.setUint16(6, 0, true); // reserved
  view.setUint32(8, recordCount, true);
  view.setUint16(12, IDX_HEADER_SIZE, true);
  view.setUint16(14, 0, true); // reserved

  return bytes;
}

export function decodeIdxHeader(bytes: Uint8Array): IdxHeader {
  if (bytes.byteLength < IDX_HEADER_SIZE) {
    throw new PreflopStoreError("INVALID_FORMAT", `Invalid .idx header length: ${bytes.byteLength}`, { expected: IDX_HEADER_SIZE, got: bytes.byteLength });
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );

  return {
    magic,
    version: view.getUint16(4, true),
    recordCount: view.getUint32(8, true),
    headerSize: view.getUint16(12, true),
  };
}

export function assertIdxHeader(header: IdxHeader): void {
  if (header.magic !== IDX_MAGIC) {
    throw new PreflopStoreError("INVALID_FORMAT", `Invalid .idx magic: ${header.magic}, expected ${IDX_MAGIC}`, { expected: IDX_MAGIC, got: header.magic });
  }
  if (header.version !== 1) {
    throw new PreflopStoreError("UNSUPPORTED_DATA_VERSION", `Unsupported .idx version: ${header.version}`, { expected: 1, got: header.version });
  }
  if (header.headerSize !== IDX_HEADER_SIZE) {
    throw new PreflopStoreError("INVALID_FORMAT", `Unsupported .idx header size: ${header.headerSize}`, { expected: IDX_HEADER_SIZE, got: header.headerSize });
  }
}

export function encodeIdxRecord(record: IdxRecord): Uint8Array {
  const bytes = new Uint8Array(IDX_RECORD_SIZE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  view.setUint32(0, record.concreteLineId, true);
  view.setUint32(4, record.actionSchemaId, true);
  view.setUint16(8, record.handCount, true);
  view.setUint32(10, record.offset, true);
  view.setUint32(14, record.byteLength, true);
  view.setUint32(18, record.checksum, true);

  return bytes;
}

export function decodeIdxRecord(bytes: Uint8Array): IdxRecord {
  if (bytes.byteLength < IDX_RECORD_SIZE) {
    throw new PreflopStoreError("INVALID_FORMAT", `Invalid .idx record length: ${bytes.byteLength}, expected ${IDX_RECORD_SIZE}`, { expected: IDX_RECORD_SIZE, got: bytes.byteLength });
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  return {
    concreteLineId: view.getUint32(0, true),
    actionSchemaId: view.getUint32(4, true),
    handCount: view.getUint16(8, true),
    offset: view.getUint32(10, true),
    byteLength: view.getUint32(14, true),
    checksum: view.getUint32(18, true),
  };
}

/**
 * 直接从 buffer + byteOffset 解码一条 IdxRecord，无需中间 Uint8Array 分配。
 */
export function decodeIdxRecordAt(buffer: ArrayBufferLike, byteOffset: number): IdxRecord {
  const view = new DataView(buffer, byteOffset, IDX_RECORD_SIZE);

  return {
    concreteLineId: view.getUint32(0, true),
    actionSchemaId: view.getUint32(4, true),
    handCount: view.getUint16(8, true),
    offset: view.getUint32(10, true),
    byteLength: view.getUint32(14, true),
    checksum: view.getUint32(18, true),
  };
}
