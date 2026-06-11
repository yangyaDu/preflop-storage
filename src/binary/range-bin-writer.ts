import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { crc32c } from "./crc32c";
import { encodeFileHeader, RANGE_FILE_HEADER_SIZE } from "./file-header";

export interface AppendedRangePack {
  offset: number;
  byteLength: number;
  checksum: number;
}

export class RangeBinWriter {
  private constructor(
    private readonly file: FileHandle,
    private offset: number,
  ) {}

  static async create(path: string, options: { overwrite?: boolean } = {}): Promise<RangeBinWriter> {
    await mkdir(dirname(path), { recursive: true });
    const file = await open(path, options.overwrite ? "w+" : "wx+");
    const header = encodeFileHeader();
    await file.write(header, 0, header.byteLength, 0);
    return new RangeBinWriter(file, RANGE_FILE_HEADER_SIZE);
  }

  async append(bytes: Uint8Array): Promise<AppendedRangePack> {
    const offset = this.offset;
    await this.file.write(bytes, 0, bytes.byteLength, offset);
    this.offset += bytes.byteLength;

    return {
      offset,
      byteLength: bytes.byteLength,
      checksum: crc32c(bytes),
    };
  }

  async close(): Promise<void> {
    await this.file.close();
  }
}
