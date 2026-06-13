import { openSync, readSync, closeSync } from "node:fs";
import { assertSupportedHeader, decodeFileHeader, RANGE_FILE_HEADER_SIZE } from "./file-header";

/**
 * 按需文件读取器。
 *
 * 启动时只 open fd + 校验 header，不加载文件到内存。
 * 每次 read/readRaw 通过 fs.readSync 按需读取指定偏移量处的数据。
 *
 * 内存占用仅 fd + 临时 Buffer（每次查询分配），适合大文件场景（>= 10 MB）。
 * OS 文件缓存透明管理冷热数据分离，行为与 SQLite 一致。
 */
export class RangeBinFileReader {
  private fd: number | null = null;

  constructor(private readonly path: string) {}

  open(): void {
    if (this.fd !== null) return;

    const fd = openSync(this.path, "r");
    try {
      const headerBuf = Buffer.alloc(RANGE_FILE_HEADER_SIZE);
      const bytesRead = readSync(fd, headerBuf, 0, RANGE_FILE_HEADER_SIZE, 0);
      if (bytesRead < RANGE_FILE_HEADER_SIZE) {
        throw new Error(
          `Failed to read file header from ${this.path}: expected ${RANGE_FILE_HEADER_SIZE} bytes, got ${bytesRead}`,
        );
      }
      const header = decodeFileHeader(headerBuf);
      assertSupportedHeader(header);
      this.fd = fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  read(offset: number, byteLength: number): Uint8Array {
    const fd = this.ensureOpen();
    if (offset < RANGE_FILE_HEADER_SIZE) throw new Error(`Invalid range pack offset: ${offset}`);
    if (byteLength < 0) throw new Error(`Invalid byte length: ${byteLength}`);

    const buf = Buffer.alloc(byteLength);
    const bytesRead = readSync(fd, buf, 0, byteLength, offset);
    if (bytesRead < byteLength) {
      throw new Error(`Short read at offset ${offset}: expected ${byteLength}, got ${bytesRead}`);
    }
    return buf;
  }

  /**
   * 零视图读取：返回底层 buffer + 偏移量。
   * 新分配的 Buffer 从 offset 0 开始，调用方可直接构造 TypedArray 视图。
   */
  readRaw(offset: number, byteLength: number): { buffer: ArrayBufferLike; byteOffset: number; byteLength: number } {
    const fd = this.ensureOpen();
    if (offset < RANGE_FILE_HEADER_SIZE) throw new Error(`Invalid range pack offset: ${offset}`);
    if (byteLength < 0) throw new Error(`Invalid byte length: ${byteLength}`);

    const buf = Buffer.alloc(byteLength);
    const bytesRead = readSync(fd, buf, 0, byteLength, offset);
    if (bytesRead < byteLength) {
      throw new Error(`Short read at offset ${offset}: expected ${byteLength}, got ${bytesRead}`);
    }
    return { buffer: buf.buffer, byteOffset: buf.byteOffset, byteLength };
  }

  close(): void {
    if (this.fd === null) return;
    closeSync(this.fd);
    this.fd = null;
  }

  private ensureOpen(): number {
    if (this.fd === null) throw new Error("RangeBinFileReader is not opened");
    return this.fd;
  }
}
