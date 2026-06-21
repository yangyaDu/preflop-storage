export type CliArgs = Record<string, string | string[] | true>;

export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    const value = !next || next.startsWith("--") ? true : next;
    if (value !== true) index += 1;

    const existing = args[key];
    if (existing === undefined) {
      args[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(String(value));
    } else {
      args[key] = [String(existing), String(value)];
    }
  }

  return args;
}

export function getStringArg(args: CliArgs, key: string, fallback?: string): string {
  const value = args[key];
  if (Array.isArray(value)) return value[value.length - 1];
  if (typeof value === "string") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required --${key}`);
}

export function getNumberArg(args: CliArgs, key: string, fallback?: number): number {
  const value = args[key];
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required --${key}`);
  }

  const text = Array.isArray(value) ? value[value.length - 1] : String(value);
  const number = Number(text);
  if (!Number.isFinite(number)) throw new Error(`Invalid number for --${key}: ${text}`);
  return number;
}

export function getBooleanArg(args: CliArgs, key: string): boolean {
  return args[key] === true || args[key] === "true";
}

export function getNumberListArg(args: CliArgs, key: string, fallback?: number[]): number[] {
  const value = args[key];
  if (value === undefined || value === true) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required --${key}`);
  }

  const text = Array.isArray(value) ? value[value.length - 1] : String(value);
  const numbers = text.split(",").map((part) => {
    const n = Number(part.trim());
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      throw new Error(`Invalid number in --${key}: ${part}`);
    }
    return n;
  });

  if (numbers.length === 0) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Empty --${key} list`);
  }

  return numbers;
}

export function getRepeatedStringArgs(args: CliArgs, key: string): string[] {
  const value = args[key];
  if (value === undefined || value === true) return [];
  return Array.isArray(value) ? value : [value];
}

export function isHelpRequested(args: CliArgs): boolean {
  return getBooleanArg(args, "help") || getBooleanArg(args, "h");
}

export function assertKnownArgs(args: CliArgs, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.map((key) => `--${key}`).join(", ")}`);
  }
}

export function getPositiveIntegerArg(args: CliArgs, key: string, fallback?: number): number {
  const value = getNumberArg(args, key, fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${key} must be a positive integer, got ${value}`);
  }
  return value;
}

export function getNonNegativeIntegerArg(args: CliArgs, key: string, fallback?: number): number {
  const value = getNumberArg(args, key, fallback);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`--${key} must be a non-negative integer, got ${value}`);
  }
  return value;
}
