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

export function getRepeatedStringArgs(args: CliArgs, key: string): string[] {
  const value = args[key];
  if (value === undefined || value === true) return [];
  return Array.isArray(value) ? value : [value];
}
