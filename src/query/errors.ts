export type PreflopQueryErrorCode =
  | "UNKNOWN_HAND"
  | "PACK_NOT_FOUND"
  | "ACTION_SCHEMA_NOT_FOUND"
  | "BIN_FILE_NOT_FOUND"
  | "INVALID_FORMAT"
  | "CHECKSUM_MISMATCH"
  | "UNSUPPORTED_DATA_VERSION";

export type PreflopStoreErrorCode =
  | "INVALID_FORMAT"
  | "INVALID_ARGUMENT"
  | "IO_ERROR"
  | "BUILD_ERROR"
  | "UNSUPPORTED_DATA_VERSION";

export interface PreflopQueryErrorInfo {
  code: PreflopQueryErrorCode;
  message: string;
  details?: Record<string, string | number | boolean | null>;
}

/**
 * Base error for preflop-storage library.
 *
 * Used for format-level and I/O errors in the binary codec, importer,
 * and build tools. Prefer this over plain `Error` for user-actionable
 * failures. Plain `Error` is still acceptable for internal invariant
 * violations (should-never-happen bugs).
 */
export class PreflopStoreError extends Error {
  constructor(
    readonly code: PreflopStoreErrorCode,
    message: string,
    readonly details: Record<string, string | number | boolean | null> = {},
  ) {
    super(message);
    this.name = "PreflopStoreError";
  }
}

export class PreflopQueryError extends Error {
  constructor(
    readonly code: PreflopQueryErrorCode,
    message: string,
    readonly details: Record<string, string | number | boolean | null> = {},
  ) {
    super(message);
    this.name = "PreflopQueryError";
  }

  toJSON(): PreflopQueryErrorInfo {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

export function toPreflopQueryError(
  error: unknown,
  fallbackCode: PreflopQueryErrorCode = "INVALID_FORMAT",
  details: Record<string, string | number | boolean | null> = {},
): PreflopQueryError {
  if (error instanceof PreflopQueryError) return error;

  if (error instanceof PreflopStoreError) {
    const code: PreflopQueryErrorCode =
      error.code === "UNSUPPORTED_DATA_VERSION"
        ? "UNSUPPORTED_DATA_VERSION"
        : error.code === "INVALID_FORMAT"
          ? "INVALID_FORMAT"
          : fallbackCode;
    return new PreflopQueryError(code, error.message, { ...details, ...error.details });
  }

  const message = error instanceof Error ? error.message : String(error);
  const nativeCode = parseNativeQueryErrorCode(message);
  if (nativeCode) {
    return new PreflopQueryError(nativeCode, stripNativeQueryErrorPrefix(message), details);
  }

  if (message.includes("ENOENT") || message.includes("No such file")) {
    return new PreflopQueryError("BIN_FILE_NOT_FOUND", message, details);
  }

  return new PreflopQueryError(fallbackCode, message, details);
}

export function toPreflopQueryErrorInfo(
  error: unknown,
  fallbackCode: PreflopQueryErrorCode = "INVALID_FORMAT",
  details: Record<string, string | number | boolean | null> = {},
): PreflopQueryErrorInfo {
  if (error instanceof PreflopQueryError) return error.toJSON();

  return toPreflopQueryError(error, fallbackCode, details).toJSON();
}

function parseNativeQueryErrorCode(message: string): PreflopQueryErrorCode | null {
  if (message.startsWith("PFS_CHECKSUM_MISMATCH:")) return "CHECKSUM_MISMATCH";
  if (message.startsWith("PFS_INVALID_FORMAT:")) return "INVALID_FORMAT";
  if (message.startsWith("PFS_UNSUPPORTED_DATA_VERSION:")) return "UNSUPPORTED_DATA_VERSION";
  if (message.startsWith("PFS_BIN_FILE_NOT_FOUND:")) return "BIN_FILE_NOT_FOUND";
  if (message.startsWith("PFS_IO_ERROR:")) return "BIN_FILE_NOT_FOUND";

  return null;
}

function stripNativeQueryErrorPrefix(message: string): string {
  return message.replace(/^PFS_[A-Z_]+:\s*/, "");
}
