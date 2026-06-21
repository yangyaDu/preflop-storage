import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const projectRoot = join(import.meta.dir, "..");

describe(".idx cross-language format constants", () => {
  test("TypeScript and Rust definitions stay in sync", () => {
    const tsSource = readFileSync(join(projectRoot, "src", "range-strata-binary", "index", "types.ts"), "utf8");
    const rustSource = readFileSync(join(projectRoot, "native-addon", "src", "types.rs"), "utf8");

    const tsConstants = {
      IDX_MAGIC: extractTsStringConstant(tsSource, "IDX_MAGIC"),
      IDX_HEADER_SIZE: extractTsNumberConstant(tsSource, "IDX_HEADER_SIZE"),
      IDX_RECORD_SIZE: extractTsNumberConstant(tsSource, "IDX_RECORD_SIZE"),
    };

    const rustConstants = {
      IDX_MAGIC: extractRustByteStringConstant(rustSource, "IDX_MAGIC"),
      IDX_HEADER_SIZE: extractRustNumberConstant(rustSource, "IDX_HEADER_SIZE"),
      IDX_RECORD_SIZE: extractRustNumberConstant(rustSource, "IDX_RECORD_SIZE"),
    };

    expect(tsConstants).toEqual(rustConstants);
  });
});

function extractTsStringConstant(source: string, name: string): string {
  const match = new RegExp(`export const ${name}\\s*=\\s*"([^"]+)"`).exec(source);
  if (!match) throw new Error(`Missing TypeScript string constant: ${name}`);
  return match[1];
}

function extractTsNumberConstant(source: string, name: string): number {
  const match = new RegExp(`export const ${name}\\s*=\\s*(\\d+)`).exec(source);
  if (!match) throw new Error(`Missing TypeScript number constant: ${name}`);
  return Number(match[1]);
}

function extractRustByteStringConstant(source: string, name: string): string {
  const match = new RegExp(`pub const ${name}: &\\[u8; \\d+\\]\\s*=\\s*b"([^"]+)"`).exec(source);
  if (!match) throw new Error(`Missing Rust byte string constant: ${name}`);
  return match[1];
}

function extractRustNumberConstant(source: string, name: string): number {
  const match = new RegExp(`pub const ${name}: usize\\s*=\\s*(\\d+)`).exec(source);
  if (!match) throw new Error(`Missing Rust number constant: ${name}`);
  return Number(match[1]);
}
