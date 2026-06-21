import { describe, expect, test } from "bun:test";
import {
  renderRoutedCommandHelp,
  resolveCliCommand,
  shouldRenderRoutedCommandHelp,
} from "../src/cli/command-router";

describe("CLI command router", () => {
  test("prints unified help when no command is provided", () => {
    const resolution = resolveCliCommand([]);

    expect(resolution.kind).toBe("help");
    if (resolution.kind === "help") {
      expect(resolution.text).toContain("Usage:");
      expect(resolution.text).toContain("benchmark-cold");
    }
  });

  test("routes build to Range Strata Binary by default", () => {
    const resolution = resolveRun(["build", "--source", "range-db/range.db"]);

    expect(resolution.command).toBe("build");
    expect(resolution.scheme).toBe("range-strata");
    expect(resolution.scriptPath).toBe("src/range-strata-binary/cli/compile.ts");
    expect(resolution.forwardedArgv).toEqual(["--source", "range-db/range.db"]);
    expect(resolution.deprecated).toBe(false);
  });

  test("routes legacy build through Scheme1 and strips --scheme", () => {
    const resolution = resolveRun(["build", "--scheme", "scheme1", "--out", "range-db/binary"]);

    expect(resolution.command).toBe("build");
    expect(resolution.scheme).toBe("scheme1");
    expect(resolution.scriptPath).toBe("src/scheme1/cli/build-binary.ts");
    expect(resolution.forwardedArgv).toEqual(["--out", "range-db/binary"]);
    expect(resolution.deprecated).toBe(true);
  });

  test("routes query and verify to current CLI by default", () => {
    expect(resolveRun(["query"]).scriptPath).toBe("src/range-strata-binary/cli/query.ts");
    expect(resolveRun(["verify"]).scriptPath).toBe("src/range-strata-binary/cli/verify.ts");
  });

  test("routes benchmark variants", () => {
    expect(resolveRun(["benchmark"]).scriptPath).toBe("src/range-strata-binary/cli/benchmark.ts");
    expect(resolveRun(["benchmark", "--scheme", "sqlite"]).scriptPath).toBe("src/scheme1/cli/benchmark-sqlite.ts");
    expect(resolveRun(["benchmark", "--scheme", "legacy"]).scriptPath).toBe("src/scheme1/cli/benchmark-binary.ts");
  });

  test("routes single-purpose commands", () => {
    expect(resolveRun(["benchmark-cold"]).scriptPath).toBe("src/range-strata-binary/cli/cold-benchmark.ts");
    expect(resolveRun(["benchmark-compare"]).scriptPath).toBe("src/scheme1/cli/benchmark-compare.ts");
    expect(resolveRun(["analyze-sqlite"]).scriptPath).toBe("src/scheme1/cli/analyze-sqlite.ts");
    expect(resolveRun(["analyze-binary"]).scriptPath).toBe("src/scheme1/cli/analyze-binary.ts");
  });

  test("rejects unsupported scheme combinations", () => {
    expect(() => resolveCliCommand(["benchmark-cold", "--scheme", "scheme1"])).toThrow("only supports range-strata");
    expect(() => resolveCliCommand(["benchmark-compare", "--scheme", "sqlite"])).toThrow("--scheme is not supported");
    expect(() => resolveCliCommand(["build", "--scheme", "sqlite"])).toThrow("Use range-strata or scheme1");
  });

  test("requires a scheme value", () => {
    expect(() => resolveCliCommand(["build", "--scheme"])).toThrow("--scheme requires a value");
  });

  test("router owns help for legacy and benchmark commands without running them", () => {
    const sqliteBenchmark = resolveRun(["benchmark", "--scheme", "sqlite", "--help"]);
    expect(shouldRenderRoutedCommandHelp(sqliteBenchmark)).toBe(true);
    expect(renderRoutedCommandHelp(sqliteBenchmark)).toContain("Usage: bun run cli benchmark --scheme sqlite");

    const currentBuild = resolveRun(["build", "--help"]);
    expect(shouldRenderRoutedCommandHelp(currentBuild)).toBe(false);
  });
});

function resolveRun(argv: string[]) {
  const resolution = resolveCliCommand(argv);
  expect(resolution.kind).toBe("run");
  if (resolution.kind !== "run") {
    throw new Error("Expected run resolution");
  }
  return resolution;
}
