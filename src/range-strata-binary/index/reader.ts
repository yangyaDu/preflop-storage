import {
  assertIdxHeader,
  decodeIdxHeader,
  decodeIdxRecordAt,
  IDX_HEADER_SIZE,
  IDX_RECORD_SIZE,
  type IdxRecord,
} from "./types";

/**
 * RangeIdxReader — mmap .idx 文件，通过 DataView 二分查找实现 O(log n) 查询。
 *
 * 启动时一次性将整个 .idx 文件读入内存（通常远小于 .bin）。
 * 每个 record 22 字节，按 concreteLineId 升序存储。
 */
export class RangeIdxReader {
  private data: Uint8Array | null = null;
  private view: DataView | null = null;
  private _recordCount = 0;

  constructor(private readonly path: string) {}

  async open(): Promise<void> {
    if (this.data) return;

    const raw = await Bun.file(this.path).bytes();
    const headerBytes = raw.subarray(0, IDX_HEADER_SIZE);
    const header = decodeIdxHeader(headerBytes);
    assertIdxHeader(header);
    this.data = raw;
    this.view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    this._recordCount = header.recordCount;
  }

  get recordCount(): number {
    return this._recordCount;
  }

  /**
   * 二分查找 concreteLineId 对应的 IdxRecord。
   * O(log n)，零分配（每次返回新对象是唯一分配）。
   */
  find(concreteLineId: number): IdxRecord | null {
    if (!this.view) throw new Error("RangeIdxReader is not opened");
    if (this._recordCount === 0) return null;

    let left = 0;
    let right = this._recordCount - 1;

    while (left <= right) {
      const mid = (left + right) >>> 1;
      const offset = IDX_HEADER_SIZE + mid * IDX_RECORD_SIZE;
      const midLineId = this.view.getUint32(offset, true);

      if (midLineId < concreteLineId) {
        left = mid + 1;
      } else if (midLineId > concreteLineId) {
        right = mid - 1;
      } else {
        return decodeIdxRecordAt(this.data!.buffer, this.data!.byteOffset + offset);
      }
    }

    return null;
  }

  /**
   * 批量查找。逐 id 二分查找。
   * 对于 batch ≤ 50 的场景，O(k log n) 足够。
   */
  findBatch(ids: number[]): (IdxRecord | null)[] {
    return ids.map((id) => this.find(id));
  }

  close(): void {
    this.data = null;
    this.view = null;
    this._recordCount = 0;
  }
}
