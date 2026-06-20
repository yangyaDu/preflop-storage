import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  RANGE_FILE_HEADER_SIZE,
  decodeFileHeader,
  assertSupportedHeader,
} from "../../../binary/file-header";
import type { BuildManifest } from "../../compiler/types";
import { dimensionKey } from "../../catalog/naming";
import type { VerifyCheckResult, VerifyFailure } from "../report";

export function checkPackHeader(dir: string, manifest: BuildManifest): VerifyCheckResult {
  const failures: VerifyFailure[] = [];

  for (const dim of manifest.dimensions) {
    if (dim.status === "failed") continue;
    if (!dim.binFile) {
      failures.push({
        layer: "pack-header",
        check: `dimension:${dimensionKey(dim)}`,
        reason: "MISSING_FILE",
        message: `manifest.dimensions entry for ${dimensionKey(dim)} has no binFile`,
      });
      continue;
    }

    const binPath = join(dir, dim.binFile);
    try {
      const fileStat = statSync(binPath);
      if (fileStat.size < RANGE_FILE_HEADER_SIZE) {
        failures.push({
          layer: "pack-header",
          check: `dimension:${dimensionKey(dim)}`,
          reason: "TRUNCATED",
          message: `.bin file ${dim.binFile} is too small (${fileStat.size} bytes, min ${RANGE_FILE_HEADER_SIZE})`,
        });
        continue;
      }

      // Read and validate header
      const headerBytes = new Uint8Array(readFileSync(binPath).buffer, 0, RANGE_FILE_HEADER_SIZE);
      const header = decodeFileHeader(headerBytes);
      assertSupportedHeader(header);
    } catch (e) {
      failures.push({
        layer: "pack-header",
        check: `dimension:${dimensionKey(dim)}`,
        reason: "INVALID_HEADER",
        message: `.bin file ${dim.binFile}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  return { failures };
}
