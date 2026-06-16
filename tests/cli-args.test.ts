import { describe, expect, it } from "bun:test";
import {
  parseCliArgs,
  getStringArg,
  getNumberArg,
  getBooleanArg,
  getNumberListArg,
  getRepeatedStringArgs,
} from "../src/cli/args";

// ─── parseCliArgs ──────────────────────────────────────────────────

describe("parseCliArgs", () => {
  it("returns empty object for empty argv", () => {
    expect(parseCliArgs([])).toEqual({});
  });

  it("parses a boolean flag", () => {
    expect(parseCliArgs(["--flag"])).toEqual({ flag: true });
  });

  it("parses multiple boolean flags", () => {
    expect(parseCliArgs(["--a", "--b"])).toEqual({ a: true, b: true });
  });

  it("parses a key-value pair", () => {
    expect(parseCliArgs(["--key", "value"])).toEqual({ key: "value" });
  });

  it("parses a repeated key into an array", () => {
    expect(parseCliArgs(["--key", "a", "--key", "b"])).toEqual({ key: ["a", "b"] });
  });

  it("converts a single value to array on third occurrence", () => {
    expect(parseCliArgs(["--key", "a", "--key", "b", "--key", "c"])).toEqual({ key: ["a", "b", "c"] });
  });

  it("throws on positional argument without -- prefix", () => {
    expect(() => parseCliArgs(["positional"])).toThrow("Unexpected positional argument: positional");
  });

  it("treats non-flag token after a key as its value (not positional)", () => {
    expect(parseCliArgs(["--flag", "positional"])).toEqual({ flag: "positional" });
  });

  it("treats a key at the end of argv as a flag (no next value)", () => {
    expect(parseCliArgs(["--key"])).toEqual({ key: true });
  });

  it("handles flag followed by another flag (value is next token starting with --)", () => {
    expect(parseCliArgs(["--flag1", "--flag2"])).toEqual({ flag1: true, flag2: true });
  });

  it("handles value containing equals sign", () => {
    expect(parseCliArgs(["--key", "a=b"])).toEqual({ key: "a=b" });
  });

  it("handles numeric value as string", () => {
    expect(parseCliArgs(["--key", "42"])).toEqual({ key: "42" });
  });

  it("treats empty string as falsy (value becomes true, next iteration throws)", () => {
    // Empty string is falsy, so !next === true and value becomes true.
    // The loop then stays on the flag and the next iteration hits "" as a positional argument.
    expect(() => parseCliArgs(["--key", ""])).toThrow("Unexpected positional argument:");
  });
});

// ─── getStringArg ──────────────────────────────────────────────────

describe("getStringArg", () => {
  it("returns value when key exists as a string", () => {
    const args = parseCliArgs(["--name", "hello"]);
    expect(getStringArg(args, "name")).toBe("hello");
  });

  it("returns last value when key exists as an array", () => {
    const args = parseCliArgs(["--name", "a", "--name", "b"]);
    expect(getStringArg(args, "name")).toBe("b");
  });

  it("returns fallback when key is missing", () => {
    expect(getStringArg({}, "name", "default")).toBe("default");
  });

  it("throws when key is missing and no fallback", () => {
    expect(() => getStringArg({}, "name")).toThrow("Missing required --name");
  });

  it("returns fallback when key is a boolean flag with fallback", () => {
    const args = parseCliArgs(["--name"]);
    expect(getStringArg(args, "name", "fallback")).toBe("fallback");
  });

  it("throws when key is a boolean flag without fallback", () => {
    const args = parseCliArgs(["--name"]);
    expect(() => getStringArg(args, "name")).toThrow("Missing required --name");
  });
});

// ─── getNumberArg ──────────────────────────────────────────────────

describe("getNumberArg", () => {
  it("parses a valid number string", () => {
    const args = parseCliArgs(["--count", "42"]);
    expect(getNumberArg(args, "count")).toBe(42);
  });

  it("parses zero", () => {
    const args = parseCliArgs(["--count", "0"]);
    expect(getNumberArg(args, "count")).toBe(0);
  });

  it("parses negative number", () => {
    const args = parseCliArgs(["--count", "-5"]);
    expect(getNumberArg(args, "count")).toBe(-5);
  });

  it("parses float number", () => {
    const args = parseCliArgs(["--count", "3.14"]);
    expect(getNumberArg(args, "count")).toBe(3.14);
  });

  it("returns last value when key exists as an array", () => {
    const args = parseCliArgs(["--count", "10", "--count", "20"]);
    expect(getNumberArg(args, "count")).toBe(20);
  });

  it("returns fallback when key is missing", () => {
    expect(getNumberArg({}, "count", 99)).toBe(99);
  });

  it("throws when key is missing and no fallback", () => {
    expect(() => getNumberArg({}, "count")).toThrow("Missing required --count");
  });

  it("throws on invalid number string", () => {
    const args = parseCliArgs(["--count", "abc"]);
    expect(() => getNumberArg(args, "count")).toThrow("Invalid number for --count: abc");
  });

  it("throws when key is a boolean flag (true parses to NaN)", () => {
    const args = parseCliArgs(["--count"]);
    expect(() => getNumberArg(args, "count")).toThrow("Invalid number for --count: true");
  });

  it("returns fallback when key is missing (value is undefined)", () => {
    expect(getNumberArg({}, "missing", 0)).toBe(0);
  });
});

// ─── getBooleanArg ─────────────────────────────────────────────────

describe("getBooleanArg", () => {
  it("returns true for a flag (true)", () => {
    const args = parseCliArgs(["--verbose"]);
    expect(getBooleanArg(args, "verbose")).toBe(true);
  });

  it("returns true for string 'true'", () => {
    const args = parseCliArgs(["--verbose", "true"]);
    expect(getBooleanArg(args, "verbose")).toBe(true);
  });

  it("returns false for missing key", () => {
    expect(getBooleanArg({}, "verbose")).toBe(false);
  });

  it("returns false for string 'false'", () => {
    const args = parseCliArgs(["--verbose", "false"]);
    expect(getBooleanArg(args, "verbose")).toBe(false);
  });

  it("returns false when value is an array (neither true nor 'true')", () => {
    // getBooleanArg checks === true or === "true", not the last array element
    const args = parseCliArgs(["--verbose", "false", "--verbose", "true"]);
    expect(getBooleanArg(args, "verbose")).toBe(false);
  });
});

// ─── getNumberListArg ──────────────────────────────────────────────

describe("getNumberListArg", () => {
  it("parses comma-separated numbers", () => {
    const args = parseCliArgs(["--sizes", "1,5,10,50"]);
    expect(getNumberListArg(args, "sizes")).toEqual([1, 5, 10, 50]);
  });

  it("parses a single number", () => {
    const args = parseCliArgs(["--sizes", "42"]);
    expect(getNumberListArg(args, "sizes")).toEqual([42]);
  });

  it("trims spaces around values", () => {
    const args = parseCliArgs(["--sizes", " 1 , 5 , 10 "]);
    expect(getNumberListArg(args, "sizes")).toEqual([1, 5, 10]);
  });

  it("returns fallback when key is missing", () => {
    expect(getNumberListArg({}, "sizes", [1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("throws when key is missing and no fallback", () => {
    expect(() => getNumberListArg({}, "sizes")).toThrow("Missing required --sizes");
  });

  it("throws on non-integer value", () => {
    const args = parseCliArgs(["--sizes", "1.5,2"]);
    expect(() => getNumberListArg(args, "sizes")).toThrow("Invalid number in --sizes: 1.5");
  });

  it("throws on non-numeric value", () => {
    const args = parseCliArgs(["--sizes", "1,abc,3"]);
    expect(() => getNumberListArg(args, "sizes")).toThrow("Invalid number in --sizes: abc");
  });

  it("throws on zero", () => {
    const args = parseCliArgs(["--sizes", "0,1"]);
    expect(() => getNumberListArg(args, "sizes")).toThrow("Invalid number in --sizes: 0");
  });

  it("throws on negative number", () => {
    const args = parseCliArgs(["--sizes", "-1,2"]);
    expect(() => getNumberListArg(args, "sizes")).toThrow("Invalid number in --sizes: -1");
  });

  it("returns last value for repeated keys", () => {
    const args = parseCliArgs(["--sizes", "1,2", "--sizes", "3,4"]);
    expect(getNumberListArg(args, "sizes")).toEqual([3, 4]);
  });

  it("returns fallback when key is a flag (true) with fallback", () => {
    const args = parseCliArgs(["--sizes"]);
    expect(getNumberListArg(args, "sizes", [100])).toEqual([100]);
  });

  it("throws when key is a flag (true) without fallback", () => {
    const args = parseCliArgs(["--sizes"]);
    expect(() => getNumberListArg(args, "sizes")).toThrow("Missing required --sizes");
  });
});

// ─── getRepeatedStringArgs ─────────────────────────────────────────

describe("getRepeatedStringArgs", () => {
  it("returns empty array for missing key", () => {
    expect(getRepeatedStringArgs({}, "dimension")).toEqual([]);
  });

  it("returns empty array for a flag (true)", () => {
    const args = parseCliArgs(["--dimension"]);
    expect(getRepeatedStringArgs(args, "dimension")).toEqual([]);
  });

  it("returns single value as an array", () => {
    const args = parseCliArgs(["--dimension", "default:6:100"]);
    expect(getRepeatedStringArgs(args, "dimension")).toEqual(["default:6:100"]);
  });

  it("returns multiple values as an array", () => {
    const args = parseCliArgs(["--dimension", "a", "--dimension", "b", "--dimension", "c"]);
    expect(getRepeatedStringArgs(args, "dimension")).toEqual(["a", "b", "c"]);
  });
});
