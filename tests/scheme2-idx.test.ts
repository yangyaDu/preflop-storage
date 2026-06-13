import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  IdxRecord,
  encodeIdxHeader,
  decodeIdxHeader,
  assertIdxHeader,
  encodeIdxRecord,
  decodeIdxRecord,
  IDX_MAGIC,
  IDX_HEADER_SIZE,
  IDX_RECORD_SIZE,
} from "../src/scheme2/idx/idx-types";
import { RangeIdxWriter } from "../src/scheme2/idx/idx-writer";
import { RangeIdxReader } from "../src/scheme2/idx/idx-reader";

const TEST_DIR = join(import.meta.dirname, "temp-test-idx");

function sampleRecord(concreteLineId: number): IdxRecord {
  return {
    concreteLineId,
    actionSchemaId: (concreteLineId * 3) % 100,
    handCount: (concreteLineId % 1326) + 1,
    offset: concreteLineId * 1000 + 16,
    byteLength: 500 + (concreteLineId % 200),
    checksum: (concreteLineId * 0x6d2b79f5) >>> 0,
  };
}

describe("IdxTypes", () => {
  it("encodeIdxHeader → decodeIdxHeader roundtrip", () => {
    const header = encodeIdxHeader(42);
    expect(header.byteLength).toBe(IDX_HEADER_SIZE);

    const decoded = decodeIdxHeader(header);
    expect(decoded.magic).toBe(IDX_MAGIC);
    expect(decoded.version).toBe(1);
    expect(decoded.recordCount).toBe(42);
    expect(decoded.headerSize).toBe(IDX_HEADER_SIZE);

    assertIdxHeader(decoded);
  });

  it("encodeIdxRecord → decodeIdxRecord roundtrip", () => {
    const record = sampleRecord(7);
    const bytes = encodeIdxRecord(record);
    expect(bytes.byteLength).toBe(IDX_RECORD_SIZE);

    const decoded = decodeIdxRecord(bytes);
    expect(decoded.concreteLineId).toBe(7);
    expect(decoded.actionSchemaId).toBe(21);
    expect(decoded.handCount).toBe(8);
    expect(decoded.offset).toBe(7016);
    expect(decoded.byteLength).toBe(507);
    expect(decoded.checksum).toBe((7 * 0x6d2b79f5) >>> 0);
  });

  it("assertIdxHeader rejects wrong magic", () => {
    expect(() => assertIdxHeader({ magic: "XXXX", version: 1, recordCount: 0, headerSize: IDX_HEADER_SIZE })).toThrow();
  });

  it("assertIdxHeader rejects wrong version", () => {
    expect(() => assertIdxHeader({ magic: IDX_MAGIC, version: 2, recordCount: 0, headerSize: IDX_HEADER_SIZE })).toThrow();
  });

  it("assertIdxHeader rejects wrong header size", () => {
    expect(() => assertIdxHeader({ magic: IDX_MAGIC, version: 1, recordCount: 0, headerSize: 32 })).toThrow();
  });

  it("decodeIdxRecord with truncated bytes throws", () => {
    const bytes = new Uint8Array(10);
    expect(() => decodeIdxRecord(bytes)).toThrow();
  });

  it("decodeIdxHeader with truncated bytes throws", () => {
    const bytes = new Uint8Array(8);
    expect(() => decodeIdxHeader(bytes)).toThrow();
  });
});

describe("RangeIdxWriter → RangeIdxReader roundtrip", () => {
  const idxPath = join(TEST_DIR, "test.idx");

  beforeAll(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("writes and reads records correctly (sorted by concreteLineId ascending)", async () => {
    const writer = await RangeIdxWriter.create(idxPath, { overwrite: true });

    const records: IdxRecord[] = [];
    for (let i = 0; i < 100; i++) {
      const record = sampleRecord(i + 1);
      records.push(record);
      await writer.append(record);
    }
    await writer.close();

    const reader = new RangeIdxReader(idxPath);
    await reader.open();
    expect(reader.recordCount).toBe(100);

    // Find every record
    for (let i = 0; i < 100; i++) {
      const found = reader.find(i + 1);
      expect(found).not.toBeNull();
      expect(found!.concreteLineId).toBe(i + 1);
      expect(found!.actionSchemaId).toBe(records[i].actionSchemaId);
      expect(found!.handCount).toBe(records[i].handCount);
      expect(found!.offset).toBe(records[i].offset);
      expect(found!.byteLength).toBe(records[i].byteLength);
      expect(found!.checksum).toBe(records[i].checksum);
    }

    reader.close();
  });

  it("find returns null for non-existent concreteLineId", async () => {
    const reader = new RangeIdxReader(idxPath);
    await reader.open();

    expect(reader.find(0)).toBeNull();
    expect(reader.find(101)).toBeNull();
    expect(reader.find(9999)).toBeNull();

    reader.close();
  });

  it("findBatch returns results for all ids", async () => {
    const reader = new RangeIdxReader(idxPath);
    await reader.open();

    const ids = [1, 5, 10, 50, 100, 999];
    const results = reader.findBatch(ids);
    expect(results.length).toBe(6);
    expect(results[0]!.concreteLineId).toBe(1);
    expect(results[1]!.concreteLineId).toBe(5);
    expect(results[2]!.concreteLineId).toBe(10);
    expect(results[3]!.concreteLineId).toBe(50);
    expect(results[4]!.concreteLineId).toBe(100);
    expect(results[5]).toBeNull();

    reader.close();
  });
});

describe("RangeIdxReader binary search", () => {
  const idxPath = join(TEST_DIR, "search.idx");

  beforeAll(async () => {
    await mkdir(TEST_DIR, { recursive: true });

    const writer = await RangeIdxWriter.create(idxPath, { overwrite: true });
    // Sorted concreteLineIds: 3, 7, 15, 23, 42, 56, 78, 91, 100, 200
    const ids = [3, 7, 15, 23, 42, 56, 78, 91, 100, 200];
    for (const id of ids) {
      await writer.append(sampleRecord(id));
    }
    await writer.close();
  });

  it("finds existing records with binary search", async () => {
    const reader = new RangeIdxReader(idxPath);
    await reader.open();
    expect(reader.recordCount).toBe(10);

    expect(reader.find(3)!.concreteLineId).toBe(3);
    expect(reader.find(7)!.concreteLineId).toBe(7);
    expect(reader.find(42)!.concreteLineId).toBe(42);
    expect(reader.find(200)!.concreteLineId).toBe(200);

    reader.close();
  });

  it("returns null for missing ids (binary search edge cases)", async () => {
    const reader = new RangeIdxReader(idxPath);
    await reader.open();

    expect(reader.find(1)).toBeNull();   // before first
    expect(reader.find(4)).toBeNull();   // between 3 and 7
    expect(reader.find(50)).toBeNull();  // between 42 and 56
    expect(reader.find(99)).toBeNull();  // between 91 and 100
    expect(reader.find(201)).toBeNull(); // after last

    reader.close();
  });
});
