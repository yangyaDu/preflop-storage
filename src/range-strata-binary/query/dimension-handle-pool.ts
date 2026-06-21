import { join } from "node:path";
import { getBinFileName } from "../../db/naming";
import { PreflopQueryError, toPreflopQueryError } from "../../query/errors";
import { getIdxFileName } from "../catalog/naming";
import { DimensionHandle } from "../../../native-addon/index.js";

export interface DimensionRef {
  strategy?: string;
  playerCount: number;
  depthBb: number;
}

export interface DimensionFileNames {
  idxFileName: string;
  binFileName: string;
}

export class DimensionHandlePool {
  private readonly handles = new Map<string, DimensionHandle>();
  private readonly lru: string[] = [];

  constructor(
    private readonly binaryDir: string,
    private readonly maxOpenHandles: number,
  ) {}

  get(params: DimensionRef): DimensionHandle | null {
    const key = this.key(params);
    const handle = this.handles.get(key);
    if (!handle) return null;
    this.touch(key);
    return handle;
  }

  require(params: DimensionRef): DimensionHandle {
    const names = this.fileNames(params);
    const key = this.keyFromFileNames(names);
    const handle = this.handles.get(key);

    if (!handle) {
      throw new PreflopQueryError(
        "BIN_FILE_NOT_FOUND",
        "Dimension handle not cached. Call prewarmDimension() first.",
        fileNameDetails(names),
      );
    }

    this.touch(key);
    return handle;
  }

  prewarm(params: DimensionRef): DimensionHandle {
    const names = this.fileNames(params);
    const key = this.keyFromFileNames(names);
    const cached = this.handles.get(key);

    if (cached) {
      this.touch(key);
      return cached;
    }

    const idxPath = join(this.binaryDir, names.idxFileName);
    const binPath = join(this.binaryDir, names.binFileName);

    try {
      const handle = new DimensionHandle(idxPath, binPath);
      this.handles.set(key, handle);
      this.touch(key);
      this.evictLRU();
      return handle;
    } catch (error) {
      throw toPreflopQueryError(error, "BIN_FILE_NOT_FOUND", fileNameDetails(names));
    }
  }

  fileNames(params: DimensionRef): DimensionFileNames {
    const strategy = params.strategy ?? "default";
    return {
      idxFileName: getIdxFileName(strategy, params.playerCount, params.depthBb),
      binFileName: getBinFileName(strategy, params.playerCount, params.depthBb),
    };
  }

  clear(): void {
    this.handles.clear();
    this.lru.length = 0;
  }

  private key(params: DimensionRef): string {
    return this.keyFromFileNames(this.fileNames(params));
  }

  private keyFromFileNames(names: DimensionFileNames): string {
    return `${names.idxFileName}|${names.binFileName}`;
  }

  private touch(key: string): void {
    const idx = this.lru.indexOf(key);
    if (idx !== -1) this.lru.splice(idx, 1);
    this.lru.push(key);
  }

  private evictLRU(): void {
    while (this.lru.length > this.maxOpenHandles) {
      const oldest = this.lru.shift();
      if (oldest) this.handles.delete(oldest);
    }
  }
}

function fileNameDetails(names: DimensionFileNames): Record<string, string> {
  return {
    idxFileName: names.idxFileName,
    binFileName: names.binFileName,
  };
}
