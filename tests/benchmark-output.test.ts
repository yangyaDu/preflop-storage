import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BenchmarkRunReport } from "../src/benchmark/common";
import { createBuiltRangeDbFixture, type RangeDimensionFixture } from "./helpers/range-db-fixture";
import { createTempDirRegistry } from "./helpers/temp-dir";

const tempDirs = createTempDirRegistry();
const projectRoot = join(import.meta.dir, "..");
const benchmarkScript = join(projectRoot, "src", "range-strata-binary", "cli", "benchmark.ts");

afterEach(tempDirs.cleanup);

describe("Range Strata Binary benchmark output", () => {
  test("writes stable JSON and Markdown reports with result verification", async () => {
    const { sourcePath, outDir, rootDir } = await buildFixture();
    const jsonPath = join(rootDir, "benchmark.json");
    const markdownPath = join(rootDir, "benchmark.md");

    const result = await runBenchmark([
      "--source",
      sourcePath,
      "--dir",
      outDir,
      "--out",
      jsonPath,
      "--md",
      markdownPath,
      "--iterations",
      "2",
      "--batch-iterations",
      "2",
      "--batch-size",
      "2",
      "--batch-sizes",
      "1,2",
      "--warmup-iterations",
      "0",
      "--verify-results",
    ]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(markdownPath)).toBe(true);

    const report = await readBenchmarkReport(jsonPath);
    expect(report.engine).toBe("binary");
    expect(report.sourceDbPath).toBe(sourcePath);
    expect(report.binaryDir).toBe(outDir);
    expect(report.metaDbPath).toBe(join(outDir, "meta.db"));
    expect(report.workloadSource).toBe("generated");
    expect(report.options.verifyResults).toBe(true);
    expect(report.options.batchSizes).toEqual([1, 2]);
    expect(report.workload.dimensions).toEqual(["default:6max:100BB"]);
    expect(report.workload.handQueries).toBe(2);
    expect(report.workload.batchQueries).toBe(2);
    expect(report.workload.batchSize).toBe(2);
    expect(report.coldStart?.resultCount).toBeGreaterThan(0);
    expect(report.memory.before.rssBytes).toBeGreaterThan(0);
    expect(report.memory.after.rssBytes).toBeGreaterThan(0);
    expect(report.totals.errorCount).toBe(0);
    expect(report.totals.iterations).toBe(8);
    expect(report.totals.resultCount).toBeGreaterThan(0);
    expect(report.notes.some((note) => note.includes("Result verification") && note.includes("0 mismatch"))).toBe(true);

    const caseNames = new Set(report.cases.map((item) => item.name));
    expect(caseNames).toEqual(
      new Set(["hand-strategy", "batch-hand-strategy", "batch-size-1", "batch-size-2"]),
    );
    for (const benchmarkCase of report.cases) {
      expect(benchmarkCase.iterations).toBeGreaterThan(0);
      expect(benchmarkCase.errorCount).toBe(0);
      expect(benchmarkCase.firstError).toBeNull();
    }

    const markdown = await Bun.file(markdownPath).text();
    expect(markdown).toContain("# 二进制 Benchmark 报告");
    expect(markdown).toContain("## 总览");
    expect(markdown).toContain("## Workload");
    expect(markdown).toContain("## 延迟结果");
    expect(markdown).toContain("## 内存");
    expect(markdown).toContain("## 说明");
    expect(markdown).toContain("hand-strategy");
    expect(markdown).toContain("batch-size-2");
    expect(markdown).toContain("Result verification");
  });

  test("exits non-zero and still writes reports when benchmark operations fail", async () => {
    const { sourcePath, outDir, rootDir } = await buildFixture();
    const workloadPath = join(rootDir, "bad-workload.json");
    const jsonPath = join(rootDir, "benchmark-fail.json");
    const markdownPath = join(rootDir, "benchmark-fail.md");

    await Bun.write(
      workloadPath,
      `${JSON.stringify(
        {
          seed: 7,
          mode: "random",
          dimensions: ["default:6max:100BB"],
          handQueries: [
            {
              strategy: "default",
              playerCount: 6,
              depthBb: 100,
              concreteLineId: 1,
              holeCards: "AA",
            },
            {
              strategy: "default",
              playerCount: 6,
              depthBb: 100,
              concreteLineId: 1,
              holeCards: "XX",
            },
          ],
          batchQueries: [
            {
              strategy: "default",
              playerCount: 6,
              depthBb: 100,
              requests: [{ concreteLineId: 1, holeCards: "AA" }],
            },
          ],
          batchSize: 1,
          batchQueriesBySize: [
            [
              1,
              [
                {
                  strategy: "default",
                  playerCount: 6,
                  depthBb: 100,
                  requests: [{ concreteLineId: 1, holeCards: "AA" }],
                },
              ],
            ],
          ],
        },
        null,
        2,
      )}\n`,
    );

    const result = await runBenchmark([
      "--source",
      sourcePath,
      "--dir",
      outDir,
      "--workload",
      workloadPath,
      "--out",
      jsonPath,
      "--md",
      markdownPath,
      "--warmup-iterations",
      "0",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(markdownPath)).toBe(true);

    const report = await readBenchmarkReport(jsonPath);
    expect(report.workloadSource).toBe("loaded");
    expect(report.workloadPath).toBe(workloadPath);
    expect(report.totals.errorCount).toBeGreaterThan(0);

    const handCase = report.cases.find((item) => item.name === "hand-strategy");
    expect(handCase?.errorCount).toBe(1);
    expect(handCase?.firstError).toContain("Unknown hole cards: XX");

    const markdown = await Bun.file(markdownPath).text();
    expect(markdown).toContain("hand-strategy");
    expect(markdown).toContain("错误数：1");
    expect(markdown).toContain("| hand-strategy | 2 |");
  });
});

async function runBenchmark(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn([process.execPath, benchmarkScript, ...args], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return {
    exitCode,
    stdout: await stdout,
    stderr: await stderr,
  };
}

async function readBenchmarkReport(path: string): Promise<BenchmarkRunReport> {
  return JSON.parse(await Bun.file(path).text()) as BenchmarkRunReport;
}

async function buildFixture(): Promise<{ rootDir: string; sourcePath: string; outDir: string }> {
  return createBuiltRangeDbFixture({
    tempDirs,
    prefix: "preflop-storage-benchmark-",
    spec: { dimensions: [benchmarkDimension] },
  });
}

const benchmarkDimension: RangeDimensionFixture = {
  playerCount: 6,
  depthBb: 100,
  concreteLines: [
    { id: 1, abstractLine: "R-C", concreteLine: "R2-C" },
    { id: 2, abstractLine: "R-C", concreteLine: "R3.5-C" },
  ],
  rangeRows: [
    { concreteLineId: 1, holeCards: "AA", actionName: "fold", actionSize: 0, amountBb: 0, frequency: 0.1, handEv: 0 },
    { concreteLineId: 1, holeCards: "AA", actionName: "call", actionSize: 0, amountBb: 0, frequency: 0.2, handEv: 1 },
    { concreteLineId: 1, holeCards: "AA", actionName: "raise", actionSize: 40, amountBb: 2, frequency: 0.7, handEv: 2 },
    { concreteLineId: 2, holeCards: "A3o", actionName: "fold", actionSize: 0, amountBb: 0, frequency: 0.6, handEv: 0 },
    { concreteLineId: 2, holeCards: "A3o", actionName: "call", actionSize: 0, amountBb: 0, frequency: 0.4, handEv: -1 },
    { concreteLineId: 2, holeCards: "A3o", actionName: "raise", actionSize: 40, amountBb: 2, frequency: 0, handEv: -2 },
  ],
};
