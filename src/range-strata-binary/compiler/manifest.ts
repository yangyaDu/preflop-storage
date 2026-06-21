import type { BuildManifest, BuildManifestDimension } from "./types";

export const MANIFEST_EXPECTED_FORMAT = "PFSP";
export const MANIFEST_EXPECTED_VERSION = 1;

export type BuildManifestValidationReason =
  | "INVALID_JSON"
  | "INVALID_SHAPE"
  | "INVALID_FORMAT"
  | "UNSUPPORTED_VERSION"
  | "INVALID_TIMESTAMP"
  | "EMPTY"
  | "DUPLICATE"
  | "MISSING_ENTRY";

export interface BuildManifestValidationIssue {
  check: string;
  reason: BuildManifestValidationReason;
  message: string;
}

export interface BuildManifestParseResult {
  manifest: BuildManifest | null;
  issues: BuildManifestValidationIssue[];
}

export function parseBuildManifestJson(raw: string): BuildManifestParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      manifest: null,
      issues: [
        {
          check: "parse",
          reason: "INVALID_JSON",
          message: `manifest.json is not valid JSON: ${formatUnknownError(error)}`,
        },
      ],
    };
  }

  const issues = validateBuildManifest(parsed);
  return {
    manifest: issues.length === 0 ? (parsed as BuildManifest) : null,
    issues,
  };
}

export function validateBuildManifest(value: unknown): BuildManifestValidationIssue[] {
  const issues: BuildManifestValidationIssue[] = [];
  if (!isRecord(value)) {
    return [
      {
        check: "root",
        reason: "INVALID_SHAPE",
        message: "manifest.json root must be an object",
      },
    ];
  }

  if (value.format !== MANIFEST_EXPECTED_FORMAT) {
    issues.push({
      check: "format",
      reason: "INVALID_FORMAT",
      message: `manifest.format expected "${MANIFEST_EXPECTED_FORMAT}", got "${String(value.format)}"`,
    });
  }

  if (value.version !== MANIFEST_EXPECTED_VERSION) {
    issues.push({
      check: "version",
      reason: "UNSUPPORTED_VERSION",
      message: `manifest.version expected ${MANIFEST_EXPECTED_VERSION}, got ${String(value.version)}`,
    });
  }

  if (typeof value.sourceDbChecksum !== "string") {
    issues.push({
      check: "sourceDbChecksum",
      reason: "INVALID_SHAPE",
      message: "manifest.sourceDbChecksum must be a string",
    });
  }

  if (typeof value.builtAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value.builtAt)) {
    issues.push({
      check: "builtAt",
      reason: "INVALID_TIMESTAMP",
      message: `manifest.builtAt is missing or not a valid ISO timestamp: "${String(value.builtAt)}"`,
    });
  }

  const dimensions = validateDimensions(value.dimensions, issues);
  const files = validateFiles(value.files, issues);

  if (dimensions.length > 0) {
    const seenKeys = new Set<string>();
    for (const dimension of dimensions) {
      const key = manifestDimensionKey(dimension);
      if (seenKeys.has(key)) {
        issues.push({
          check: "dimensions",
          reason: "DUPLICATE",
          message: `Duplicate dimension in manifest: ${key}`,
        });
      }
      seenKeys.add(key);
    }
  }

  if (dimensions.length > 0 && files.length > 0) {
    const fileSet = new Set(files);
    const missing: string[] = [];
    if (!fileSet.has("meta.db")) missing.push("meta.db");
    for (const dimension of dimensions) {
      if (dimension.binFile && !fileSet.has(dimension.binFile)) missing.push(dimension.binFile);
      if (dimension.idxFile && !fileSet.has(dimension.idxFile)) missing.push(dimension.idxFile);
    }
    if (missing.length > 0) {
      issues.push({
        check: "files",
        reason: "MISSING_ENTRY",
        message: `manifest.files missing entries: ${missing.join(", ")}`,
      });
    }
  }

  return issues;
}

export function formatBuildManifestIssues(issues: BuildManifestValidationIssue[]): string {
  return issues.map((issue) => `${issue.check}: ${issue.message}`).join("; ");
}

function validateDimensions(value: unknown, issues: BuildManifestValidationIssue[]): BuildManifestDimension[] {
  if (!Array.isArray(value)) {
    issues.push({
      check: "dimensions",
      reason: "INVALID_SHAPE",
      message: "manifest.dimensions must be an array",
    });
    return [];
  }

  if (value.length === 0) {
    issues.push({
      check: "dimensions",
      reason: "EMPTY",
      message: "manifest.dimensions is empty",
    });
    return [];
  }

  const dimensions: BuildManifestDimension[] = [];
  for (let index = 0; index < value.length; index++) {
    const rawDimension = value[index];
    if (!isRecord(rawDimension)) {
      issues.push({
        check: `dimensions[${index}]`,
        reason: "INVALID_SHAPE",
        message: `manifest.dimensions[${index}] must be an object`,
      });
      continue;
    }

    validateRequiredString(rawDimension, "strategy", `dimensions[${index}].strategy`, issues);
    validatePositiveInteger(rawDimension, "playerCount", `dimensions[${index}].playerCount`, issues);
    validateNonNegativeInteger(rawDimension, "depthBb", `dimensions[${index}].depthBb`, issues);
    validateNonNegativeInteger(rawDimension, "concreteLineCount", `dimensions[${index}].concreteLineCount`, issues);
    validateNonNegativeInteger(rawDimension, "packCount", `dimensions[${index}].packCount`, issues);
    validateOptionalStatus(rawDimension, index, issues);
    validateOptionalStringOrNull(rawDimension, "error", `dimensions[${index}].error`, issues);
    validateOptionalString(rawDimension, "binFile", `dimensions[${index}].binFile`, issues);
    validateOptionalString(rawDimension, "idxFile", `dimensions[${index}].idxFile`, issues);
    validateOptionalNonNegativeInteger(rawDimension, "binFileSizeBytes", `dimensions[${index}].binFileSizeBytes`, issues);
    validateOptionalNonNegativeInteger(rawDimension, "idxFileSizeBytes", `dimensions[${index}].idxFileSizeBytes`, issues);

    const strategy = rawDimension.strategy;
    const playerCount = rawDimension.playerCount;
    const depthBb = rawDimension.depthBb;
    const concreteLineCount = rawDimension.concreteLineCount;
    const packCount = rawDimension.packCount;
    const status = rawDimension.status;
    const error = rawDimension.error;
    const binFile = rawDimension.binFile;
    const idxFile = rawDimension.idxFile;
    const binFileSizeBytes = rawDimension.binFileSizeBytes;
    const idxFileSizeBytes = rawDimension.idxFileSizeBytes;

    if (
      typeof strategy === "string" &&
      isPositiveInteger(playerCount) &&
      isNonNegativeInteger(depthBb) &&
      isNonNegativeInteger(concreteLineCount) &&
      isNonNegativeInteger(packCount) &&
      (status === undefined || status === "success" || status === "failed") &&
      (error === undefined || error === null || typeof error === "string") &&
      (binFile === undefined || typeof binFile === "string") &&
      (idxFile === undefined || typeof idxFile === "string") &&
      (binFileSizeBytes === undefined || isNonNegativeInteger(binFileSizeBytes)) &&
      (idxFileSizeBytes === undefined || isNonNegativeInteger(idxFileSizeBytes))
    ) {
      const dimension: BuildManifestDimension = {
        strategy,
        playerCount,
        depthBb,
        concreteLineCount,
        packCount,
      };
      if (status !== undefined) dimension.status = status;
      if (error !== undefined) dimension.error = error;
      if (binFile !== undefined) dimension.binFile = binFile;
      if (idxFile !== undefined) dimension.idxFile = idxFile;
      if (binFileSizeBytes !== undefined) dimension.binFileSizeBytes = binFileSizeBytes;
      if (idxFileSizeBytes !== undefined) dimension.idxFileSizeBytes = idxFileSizeBytes;
      dimensions.push(dimension);
    }
  }

  return dimensions;
}

function validateFiles(value: unknown, issues: BuildManifestValidationIssue[]): string[] {
  if (!Array.isArray(value)) {
    issues.push({
      check: "files",
      reason: "INVALID_SHAPE",
      message: "manifest.files must be an array",
    });
    return [];
  }

  if (value.length === 0) {
    issues.push({
      check: "files",
      reason: "EMPTY",
      message: "manifest.files is empty",
    });
    return [];
  }

  const files: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const file = value[index];
    if (typeof file !== "string") {
      issues.push({
        check: `files[${index}]`,
        reason: "INVALID_SHAPE",
        message: `manifest.files[${index}] must be a string`,
      });
      continue;
    }
    files.push(file);
  }

  return files;
}

function validateRequiredString(
  record: Record<string, unknown>,
  field: string,
  check: string,
  issues: BuildManifestValidationIssue[],
): void {
  if (typeof record[field] !== "string") {
    issues.push({
      check,
      reason: "INVALID_SHAPE",
      message: `manifest.${check} must be a string`,
    });
  }
}

function validateOptionalString(
  record: Record<string, unknown>,
  field: string,
  check: string,
  issues: BuildManifestValidationIssue[],
): void {
  if (record[field] !== undefined && typeof record[field] !== "string") {
    issues.push({
      check,
      reason: "INVALID_SHAPE",
      message: `manifest.${check} must be a string when present`,
    });
  }
}

function validateOptionalStringOrNull(
  record: Record<string, unknown>,
  field: string,
  check: string,
  issues: BuildManifestValidationIssue[],
): void {
  if (record[field] !== undefined && record[field] !== null && typeof record[field] !== "string") {
    issues.push({
      check,
      reason: "INVALID_SHAPE",
      message: `manifest.${check} must be a string or null when present`,
    });
  }
}

function validatePositiveInteger(
  record: Record<string, unknown>,
  field: string,
  check: string,
  issues: BuildManifestValidationIssue[],
): void {
  if (!isPositiveInteger(record[field])) {
    issues.push({
      check,
      reason: "INVALID_SHAPE",
      message: `manifest.${check} must be a positive integer`,
    });
  }
}

function validateNonNegativeInteger(
  record: Record<string, unknown>,
  field: string,
  check: string,
  issues: BuildManifestValidationIssue[],
): void {
  if (!isNonNegativeInteger(record[field])) {
    issues.push({
      check,
      reason: "INVALID_SHAPE",
      message: `manifest.${check} must be a non-negative integer`,
    });
  }
}

function validateOptionalNonNegativeInteger(
  record: Record<string, unknown>,
  field: string,
  check: string,
  issues: BuildManifestValidationIssue[],
): void {
  if (record[field] !== undefined && !isNonNegativeInteger(record[field])) {
    issues.push({
      check,
      reason: "INVALID_SHAPE",
      message: `manifest.${check} must be a non-negative integer when present`,
    });
  }
}

function validateOptionalStatus(
  record: Record<string, unknown>,
  index: number,
  issues: BuildManifestValidationIssue[],
): void {
  const status = record.status;
  if (status !== undefined && status !== "success" && status !== "failed") {
    issues.push({
      check: `dimensions[${index}].status`,
      reason: "INVALID_SHAPE",
      message: `manifest.dimensions[${index}].status must be "success" or "failed" when present`,
    });
  }
}

function manifestDimensionKey(dimension: Pick<BuildManifestDimension, "strategy" | "playerCount" | "depthBb">): string {
  return `${dimension.strategy}:${dimension.playerCount}:${dimension.depthBb}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
