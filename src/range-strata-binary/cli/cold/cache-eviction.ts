import { open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatBytes } from "../../../analysis/format";
import type { ColdStartMode, EvictionResult } from "./types";

export async function evictCache(
  cacheMode: ColdStartMode,
  fillerSizeBytes: number,
  datasetSizeBytes: number,
): Promise<EvictionResult> {
  if (cacheMode === "process-cold") {
    return {
      requested: false,
      method: cacheMode,
      succeeded: true,
      durationMs: 0,
      fillerSizeBytes: 0,
      datasetSizeBytes,
      notes: ["OS page cache eviction was not requested."],
    };
  }

  if (cacheMode === "linux-drop-cache") {
    return evictLinuxDropCaches(datasetSizeBytes);
  }

  return evictBestEffortFileCache(fillerSizeBytes, datasetSizeBytes);
}

async function evictLinuxDropCaches(datasetSizeBytes: number): Promise<EvictionResult> {
  const start = performance.now();
  if (process.platform !== "linux") {
    return {
      requested: true,
      method: "linux-drop-cache",
      succeeded: false,
      durationMs: performance.now() - start,
      fillerSizeBytes: 0,
      datasetSizeBytes,
      notes: ["linux-drop-cache mode is only available on Linux."],
    };
  }

  try {
    await Bun.spawn(["sync"]).exited;
    await Bun.write("/proc/sys/vm/drop_caches", "3\n");
    return {
      requested: true,
      method: "linux-drop-cache",
      succeeded: true,
      durationMs: performance.now() - start,
      fillerSizeBytes: 0,
      datasetSizeBytes,
      notes: ["Wrote 3 to /proc/sys/vm/drop_caches after sync."],
    };
  } catch (error) {
    return {
      requested: true,
      method: "linux-drop-cache",
      succeeded: false,
      durationMs: performance.now() - start,
      fillerSizeBytes: 0,
      datasetSizeBytes,
      notes: [`Could not drop Linux page cache: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

async function evictBestEffortFileCache(fillerSizeBytes: number, datasetSizeBytes: number): Promise<EvictionResult> {
  const start = performance.now();
  const fillerPath = join(tmpdir(), `preflop-cold-cache-${process.pid}.bin`);
  const chunk = new Uint8Array(1024 * 1024);
  for (let i = 0; i < chunk.byteLength; i++) {
    chunk[i] = (i & 0xFF) ^ 0xAA;
  }

  try {
    const writer = await open(fillerPath, "w");
    try {
      let written = 0;
      while (written < fillerSizeBytes) {
        const length = Math.min(chunk.byteLength, fillerSizeBytes - written);
        await writer.write(chunk.subarray(0, length), 0, length, written);
        written += length;
      }
    } finally {
      await writer.close();
    }

    const reader = await open(fillerPath, "r");
    try {
      const readBuffer = Buffer.allocUnsafe(1024 * 1024);
      let read = 0;
      while (read < fillerSizeBytes) {
        const result = await reader.read(readBuffer, 0, readBuffer.length, read);
        if (result.bytesRead === 0) break;
        read += result.bytesRead;
      }
    } finally {
      await reader.close();
    }

    await rm(fillerPath, { force: true });
    const ratio = datasetSizeBytes > 0 ? fillerSizeBytes / datasetSizeBytes : 0;
    return {
      requested: true,
      method: "os-best-effort",
      succeeded: true,
      durationMs: performance.now() - start,
      fillerSizeBytes,
      datasetSizeBytes,
      notes: [
        `Filled OS file cache with ${formatBytes(fillerSizeBytes)} non-zero filler (filler/dataset = ${ratio.toFixed(1)}x). This is best-effort perturbation and does not guarantee a true cold cache.`,
      ],
    };
  } catch (error) {
    await rm(fillerPath, { force: true }).catch(() => {});
    return {
      requested: true,
      method: "os-best-effort",
      succeeded: false,
      durationMs: performance.now() - start,
      fillerSizeBytes,
      datasetSizeBytes,
      notes: [`Best-effort cache perturbation failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}
