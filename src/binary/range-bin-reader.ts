import { open, type FileHandle } from "node:fs/promises";
import { assertSupportedHeader, decodeFileHeader, RANGE_FILE_HEADER_SIZE } from "./file-header";

export class RangeBinReader {
  private file: FileHandle | null = null;

  constructor(private readonly path: string) {}

  async open(): Promise<void> {
    if (this.file) return;

    this.file = await open(this.path, "r");
    const headerBytes = Buffer.allocUnsafe(RANGE_FILE_HEADER_SIZE);
    await this.readFullyInto(headerBytes, 0);

    const header = decodeFileHeader(headerBytes);
    assertSupportedHeader(header);
  }

  async read(offset: number, byteLength: number): Promise<Uint8Array> {
    if (!this.file) throw new Error("RangeBinReader is not opened");
    if (offset < RANGE_FILE_HEADER_SIZE) throw new Error(`Invalid range pack offset: ${offset}`);
    if (byteLength < 0) throw new Error(`Invalid byte length: ${byteLength}`);

    const buffer = Buffer.allocUnsafe(byteLength);
    await this.readFullyInto(buffer, offset);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  async close(): Promise<void> {
    if (!this.file) return;
    await this.file.close();
    this.file = null;
  }

  private async readFullyInto(buffer: Uint8Array, position: number): Promise<void> {
    if (!this.file) throw new Error("RangeBinReader is not opened");

    let totalRead = 0;
    while (totalRead < buffer.byteLength) {
      const result = await this.file.read(buffer, totalRead, buffer.byteLength - totalRead, position + totalRead);
      if (result.bytesRead === 0) {
        throw new Error(`Unexpected EOF while reading ${this.path} at offset ${position + totalRead}`);
      }
      totalRead += result.bytesRead;
    }
  }
}
