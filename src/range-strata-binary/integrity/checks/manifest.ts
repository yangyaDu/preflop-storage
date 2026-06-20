import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { BuildManifest } from "../../compiler/types";
import { dimensionKey } from "../../catalog/naming";
import type { VerifyCheckResult, VerifyFailure } from "../report";

const MANIFEST_EXPECTED_FORMAT = "PFSP";
const MANIFEST_EXPECTED_VERSION = 1;

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

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      layer: "manifest",
      check: "parse",
      reason: "INVALID_JSON",
      message: `manifest.json is not valid JSON: ${String(e)}`,
    };
  }

  const m = parsed as BuildManifest;

  // format
  if (m.format !== MANIFEST_EXPECTED_FORMAT) {
    return {
      layer: "manifest",
      check: "format",
      reason: "INVALID_FORMAT",
      message: `manifest.format expected "${MANIFEST_EXPECTED_FORMAT}", got "${m.format}"`,
    };
  }

  // version
  if (m.version !== MANIFEST_EXPECTED_VERSION) {
    return {
      layer: "manifest",
      check: "version",
      reason: "UNSUPPORTED_VERSION",
      message: `manifest.version expected ${MANIFEST_EXPECTED_VERSION}, got ${m.version}`,
    };
  }

  // builtAt
  if (!m.builtAt || !/^\d{4}-\d{2}-\d{2}T/.test(m.builtAt)) {
    return {
      layer: "manifest",
      check: "builtAt",
      reason: "INVALID_TIMESTAMP",
      message: `manifest.builtAt is missing or not a valid ISO timestamp: "${m.builtAt}"`,
    };
  }

  // dimensions non-empty
  if (!Array.isArray(m.dimensions) || m.dimensions.length === 0) {
    return {
      layer: "manifest",
      check: "dimensions",
      reason: "EMPTY",
      message: "manifest.dimensions is empty",
    };
  }

  // No duplicate dimensions
  const seenKeys = new Set<string>();
  for (const dim of m.dimensions) {
    const key = dimensionKey(dim);
    if (seenKeys.has(key)) {
      return {
        layer: "manifest",
        check: "dimensions",
        reason: "DUPLICATE",
        message: `Duplicate dimension in manifest: ${key}`,
      };
    }
    seenKeys.add(key);
  }

  // files array contains expected entries
  if (!Array.isArray(m.files) || m.files.length === 0) {
    return {
      layer: "manifest",
      check: "files",
      reason: "EMPTY",
      message: "manifest.files is empty",
    };
  }

  const fileSet = new Set(m.files);
  const missing: string[] = [];
  if (!fileSet.has("meta.db")) missing.push("meta.db");
  for (const dim of m.dimensions) {
    if (dim.binFile && !fileSet.has(dim.binFile)) missing.push(dim.binFile);
    if (dim.idxFile && !fileSet.has(dim.idxFile)) missing.push(dim.idxFile);
  }
  if (missing.length > 0) {
    return {
      layer: "manifest",
      check: "files",
      reason: "MISSING_ENTRY",
      message: `manifest.files missing entries: ${missing.join(", ")}`,
    };
  }

  return { dir, manifest: m };
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
