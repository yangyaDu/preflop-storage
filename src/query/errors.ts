export type PreflopQueryErrorCode =
  | "UNKNOWN_HAND"
  | "PACK_NOT_FOUND"
  | "ACTION_SCHEMA_NOT_FOUND"
  | "BIN_FILE_NOT_FOUND"
  | "CHECKSUM_MISMATCH"
  | "UNSUPPORTED_DATA_VERSION";

export interface PreflopQueryErrorInfo {
  code: PreflopQueryErrorCode;
  message: string;
  details?: Record<string, string | number | boolean | null>;
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

export function toPreflopQueryErrorInfo(error: unknown): PreflopQueryErrorInfo {
  if (error instanceof PreflopQueryError) return error.toJSON();

  return {
    code: "PACK_NOT_FOUND",
    message: error instanceof Error ? error.message : String(error),
  };
}
