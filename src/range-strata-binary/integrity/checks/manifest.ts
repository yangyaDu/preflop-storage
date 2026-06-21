import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseBuildManifestJson } from "../../compiler/manifest";
import { dimensionKey } from "../../catalog/naming";
import type { VerifyCheckResult, VerifyFailure } from "../report";

import type { BuildManifest } from "../../compiler/types";

export interface ManifestCheckContext {
  dir: string;
  manifest: BuildManifest;
}

export function checkManifestFile(dir: string): ManifestCheckContext | VerifyFailure {
  const manifestPath = join(dir, "manifest.json");
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf-8");
  } catch {
    return {
      layer: "file-existence",
      check: "manifest.json",
      reason: "MISSING_FILE",
      message: `manifest.json not found in ${dir}`,
    };
  }

  const parsed = parseBuildManifestJson(raw);
  if (!parsed.manifest) {
    const issue = parsed.issues[0] ?? {
      check: "schema",
      reason: "INVALID_SHAPE",
      message: "manifest.json failed schema validation",
    };
    return {
      layer: "manifest",
      check: issue.check,
      reason: issue.reason,
      message: issue.message,
    };
  }

  return { dir, manifest: parsed.manifest };
}

export function checkFilesExist(ctx: ManifestCheckContext): VerifyCheckResult {
  const failures: VerifyFailure[] = [];
  const manifestPath = join(ctx.dir, "manifest.json");
  const metaDbPath = join(ctx.dir, "meta.db");

  // Check manifest.json (should exist since we just read it)
  if (!existsSync(manifestPath)) {
    failures.push({
      layer: "file-existence",
      check: "manifest.json",
      reason: "MISSING_FILE",
      message: `manifest.json not found at ${manifestPath}`,
    });
  }

  // Check meta.db
  if (!existsSync(metaDbPath)) {
    failures.push({
      layer: "file-existence",
      check: "meta.db",
      reason: "MISSING_FILE",
      message: `meta.db not found at ${metaDbPath}`,
    });
  }

  // Check per-dimension files
  for (const dim of ctx.manifest.dimensions) {
    // Skip failed dimensions — they are expected to have missing files
    if (dim.status === "failed") continue;

    const key = dimensionKey(dim);
    if (dim.binFile) {
      const binPath = join(ctx.dir, dim.binFile);
      if (!existsSync(binPath)) {
        failures.push({
          layer: "file-existence",
          check: `dimension:${key}`,
          reason: "MISSING_FILE",
          message: `.bin file not found: ${binPath}`,
        });
      }
    }
    if (dim.idxFile) {
      const idxPath = join(ctx.dir, dim.idxFile);
      if (!existsSync(idxPath)) {
        failures.push({
          layer: "file-existence",
          check: `dimension:${key}`,
          reason: "MISSING_FILE",
          message: `.idx file not found: ${idxPath}`,
        });
      }
    }
  }

  return { failures };
}
