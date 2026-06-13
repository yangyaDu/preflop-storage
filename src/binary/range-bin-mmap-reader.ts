import { assertSupportedHeader, decodeFileHeader, RANGE_FILE_HEADER_SIZE } from "./file-header";

/**
 * 零拷贝二进制文件读取器。
 *
 * 启动时将整个 .bin 文件一次性读入内存，后续所有 pack 读取通过
 * Uint8Array.subarray() 切片完成，无系统调用、无 Buffer 分配。
 *
 * 内存占用 = 文件大小（当前全部维度合计 ~272 MB）。
 * 适合只读、不可变的 range 二进制数据的服务端场景。
 */
export class RangeBinMmapReader {
  private data: Uint8Array | null = null;
  private readonly headerSize = RANGE_FILE_HEADER_SIZE;

  constructor(private readonly path: string) {}

  async open(): Promise<void> {
    if (this.data) return;

    const raw = await Bun.file(this.path).bytes();
    const headerBytes = raw.subarray(0, this.headerSize);
    const header = decodeFileHeader(headerBytes);
    assertSupportedHeader(header);
    this.data = raw;
  }

  read(offset: number, byteLength: number): Uint8Array {
    if (!this.data) throw new Error("RangeBinMmapReader is not opened");
    if (offset < this.headerSize) throw new Error(`Invalid range pack offset: ${offset}`);
    if (byteLength < 0) throw new Error(`Invalid byte length: ${byteLength}`);

    return this.data.subarray(offset, offset + byteLength);
  }

  close(): void {
    this.data = null;
  }
}
