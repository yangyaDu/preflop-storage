import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { encodeIdxHeader, encodeIdxRecord, IDX_HEADER_SIZE, type IdxRecord } from "./types";

export class RangeIdxWriter {
  private constructor(
    private readonly file: FileHandle,
    private offset: number,
    private recordCount: number,
  ) {}

  static async create(path: string, options: { overwrite?: boolean } = {}): Promise<RangeIdxWriter> {
    await mkdir(dirname(path), { recursive: true });
    const file = await open(path, options.overwrite ? "w+" : "wx+");
    // Write initial header with recordCount=0, will be rewritten on close
    const header = encodeIdxHeader(0);
    await file.write(header, 0, header.byteLength, 0);
    return new RangeIdxWriter(file, IDX_HEADER_SIZE, 0);
  }

  async append(record: IdxRecord): Promise<void> {
    const bytes = encodeIdxRecord(record);
    await this.file.write(bytes, 0, bytes.byteLength, this.offset);
    this.offset += bytes.byteLength;
    this.recordCount += 1;
  }

  async close(): Promise<void> {
    // Rewrite header with final recordCount
    const header = encodeIdxHeader(this.recordCount);
    await this.file.write(header, 0, header.byteLength, 0);
    await this.file.close();
  }
}
