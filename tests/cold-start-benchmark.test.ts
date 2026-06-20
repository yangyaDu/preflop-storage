import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBinaryStoreScheme2 } from "../src/scheme2/importer/build-binary-store";

interface ColdStartBenchmarkReport {
  mode: string;
  runsPerDimension: number;
  dimensions: Array<{
    dimension: string;
    runs: number;
    successCount: number;
    errorCount: number;
    resultCount: number;
    query: {
      concreteLineId: number;
      hand: string;
    };
    phaseTimings: {
      queryServiceImportMs: { p95Ms: number };
      dimensionPrewarmMs: { p95Ms: number };
      firstQueryMs: { p95Ms: number };
    };
    storeOpenAndFirstQueryMs: { minMs: number };
    processElapsedMs: { minMs: number };
    phaseAccounting: { unaccountedRatio: number };
    failures: Array<{
      runIndex: number;
      exitCode: number;
      error: string;
      validJson: boolean;
    }>;
  }>;
  aggregate: {
    dimensions: number;
    runs: number;
    successfulRuns: number;
    errorCount: number;
    storeOpenAndFirstQueryMs: { p50Ms: number; p95Ms: number };
    processElapsedMs: { p50Ms: number; p95Ms: number };
    phaseTimings: {
      queryServiceImportMs: { p50Ms: number; p95Ms: number };
      dimensionPrewarmMs: { p50Ms: number; p95Ms: number };
      firstQueryMs: { p50Ms: number; p95Ms: number };
      processOverheadMs: { p50Ms: number; p95Ms: number };
    };
    phaseAccounting: { unaccountedRatio: number };
    failures: Array<{
      runIndex: number;
      exitCode: number;
      error: string;
    }>;
    parentRssSamples: number[];
  };
  notes: string[];
}

const tempDirs: string[] = [];
const projectRoot = join(import.meta.dir, "..");
const coldStartScript = join(projectRoot, "src", "scheme2", "cli", "benchmark-cold-start.ts");

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await removeTempDirWithRetry(dir).catch(() => {});
  }
});

describe("Scheme2 cold-start benchmark", () => {
  test("covers every successful manifest dimension by default", async () => {
    const { sourcePath, outDir, rootDir } = await buildFixture();
    const jsonPath = join(rootDir, "cold-start.json");
    const markdownPath = join(rootDir, "cold-start.md");

    const result = await runColdStartBenchmark([
      "--source",
      sourcePath,
      "--dir",
      outDir,
      "--runs-per-dimension",
      "1",
      "--out",
      jsonPath,
      "--md",
      markdownPath,
      "--mode",
      "process-cold",
      "--cache-filler-mb",
      "1",
      "--query-policy",
      "fixed",
      "--concrete-line-id",
      "1",
      "--hand",
      "AA",
    ]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(markdownPath)).toBe(true);

    const report = await readColdStartReport(jsonPath);
    expect(report.mode).toBe("process-cold");
    expect(report.runsPerDimension).toBe(1);
    expect(report.aggregate.dimensions).toBe(2);
    expect(report.aggregate.runs).toBe(2);
    expect(report.aggregate.successfulRuns).toBe(2);
    expect(report.aggregate.errorCount).toBe(0);
    expect(report.aggregate.failures).toEqual([]);
    expect(report.aggregate.phaseTimings.queryServiceImportMs.p95Ms).toBeGreaterThanOrEqual(0);
    expect(report.aggregate.phaseTimings.dimensionPrewarmMs.p95Ms).toBeGreaterThan(0);
    expect(report.aggregate.phaseTimings.firstQueryMs.p95Ms).toBeGreaterThanOrEqual(0);
    expect(report.aggregate.phaseTimings.processOverheadMs.p95Ms).toBeGreaterThanOrEqual(0);
    expect(report.aggregate.phaseAccounting.unaccountedRatio).toBeLessThanOrEqual(0.02);
    expect(report.aggregate.parentRssSamples.length).toBe(2);
    expect(report.notes.some((note) => note.includes("cover all 9 dimensions"))).toBe(true);

    const dimensions = report.dimensions.map((item) => item.dimension);
    expect(dimensions).toEqual(["default:6max:100BB", "default:8max:200BB"]);
    for (const dimension of report.dimensions) {
      expect(dimension.runs).toBe(1);
      expect(dimension.successCount).toBe(1);
      expect(dimension.errorCount).toBe(0);
      expect(dimension.resultCount).toBeGreaterThan(0);
      expect(dimension.query.concreteLineId).toBe(1);
      expect(dimension.phaseTimings.dimensionPrewarmMs.p95Ms).toBeGreaterThan(0);
      expect(dimension.failures).toEqual([]);
      expect(dimension.phaseAccounting.unaccountedRatio).toBeLessThanOrEqual(0.02);
    }

    const markdown = await Bun.file(markdownPath).text();
    expect(markdown).toContain("# Scheme2 Cold-Start Benchmark");
    expect(markdown).toContain("## Aggregate Phase Breakdown");
    expect(markdown).toContain("## Dimension Phase Breakdown");
    expect(markdown).toContain("## Failures");
    expect(markdown).toContain("QueryService/native import");
    expect(markdown).toContain("Dimension prewarm");
    expect(markdown).toContain("default:6max:100BB");
    expect(markdown).toContain("default:8max:200BB");
    expect(markdown).toContain("Store Open+Query P95");
  });

  test("supports filtering dimensions while keeping per-dimension run counts", async () => {
    const { sourcePath, outDir, rootDir } = await buildFixture();
    const jsonPath = join(rootDir, "cold-start-filtered.json");
    const markdownPath = join(rootDir, "cold-start-filtered.md");

    const result = await runColdStartBenchmark([
      "--source",
      sourcePath,
      "--dir",
      outDir,
      "--runs",
      "2",
      "--dimension",
      "default:8:200",
      "--out",
      jsonPath,
      "--md",
      markdownPath,
      "--mode",
      "process-cold",
      "--query-policy",
      "fixed",
      "--concrete-line-id",
      "1",
      "--hand",
      "AA",
    ]);

    expect(result.exitCode).toBe(0);

    const report = await readColdStartReport(jsonPath);
    expect(report.runsPerDimension).toBe(2);
    expect(report.aggregate.dimensions).toBe(1);
    expect(report.aggregate.runs).toBe(2);
    expect(report.aggregate.successfulRuns).toBe(2);
    expect(report.aggregate.errorCount).toBe(0);
    expect(report.aggregate.phaseAccounting.unaccountedRatio).toBeLessThanOrEqual(0.02);
    expect(report.aggregate.parentRssSamples.length).toBe(1);
    expect(report.dimensions.map((item) => item.dimension)).toEqual(["default:8max:200BB"]);
    expect(report.dimensions[0].runs).toBe(2);
    expect(report.dimensions[0].successCount).toBe(2);
    expect(report.dimensions[0].query.hand).toBe("AA");
  });

  test("isolates corrupted dimension, excludes failures from latency aggregation", async () => {
    const { sourcePath, outDir, rootDir } = await buildFixture();
    // Corrupt one dimension by removing its .bin file
    const corruptedBinPath = join(outDir, "ranges_default_6max_100BB.bin");
    expect(existsSync(corruptedBinPath)).toBe(true);
    await rm(corruptedBinPath);

    const jsonPath = join(rootDir, "cold-start-failure.json");
    const result = await runColdStartBenchmark([
      "--source",
      sourcePath,
      "--dir",
      outDir,
      "--runs-per-dimension",
      "3",
      "--out",
      jsonPath,
      "--mode",
      "process-cold",
      "--query-policy",
      "first",
    ]);

    // At least one run should fail -> exitCode 1
    expect(result.exitCode).toBe(1);

    const report = await readColdStartReport(jsonPath);
    expect(report.dimensions.length).toBe(2);

    // Corrupted dimension
    const failedDim = report.dimensions.find((d) => d.dimension === "default:6max:100BB");
    expect(failedDim).toBeDefined();
    expect(failedDim!.errorCount).toBeGreaterThan(0);
    expect(failedDim!.successCount).toBeLessThan(failedDim!.runs);
    expect(failedDim!.failures.length).toBeGreaterThan(0);
    for (const f of failedDim!.failures) {
      expect(typeof f.error).toBe("string");
      expect(typeof f.runIndex).toBe("number");
    }
    // Latency aggregation for failed dimension should be empty (no successful runs)
    expect(failedDim!.storeOpenAndFirstQueryMs.minMs).toBe(0);
    expect(failedDim!.processElapsedMs.minMs).toBe(0);

    // Healthy dimension should not be affected
    const healthyDim = report.dimensions.find((d) => d.dimension === "default:8max:200BB");
    expect(healthyDim).toBeDefined();
    expect(healthyDim!.errorCount).toBe(0);
    expect(healthyDim!.successCount).toBe(healthyDim!.runs);
    expect(healthyDim!.failures).toEqual([]);
    expect(healthyDim!.storeOpenAndFirstQueryMs.minMs).toBeGreaterThan(0);
    expect(healthyDim!.processElapsedMs.minMs).toBeGreaterThan(0);

    // Aggregate: latencies come from healthy dimension only
    expect(report.aggregate.errorCount).toBeGreaterThan(0);
    expect(report.aggregate.successfulRuns).toBe(healthyDim!.runs);
    expect(report.aggregate.storeOpenAndFirstQueryMs.p50Ms).toBeGreaterThan(0);
    expect(report.aggregate.failures.length).toBeGreaterThan(0);
  });
});

async function runColdStartBenchmark(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn([process.execPath, coldStartScript, ...args], {
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

async function readColdStartReport(path: string): Promise<ColdStartBenchmarkReport> {
  return JSON.parse(await Bun.file(path).text()) as ColdStartBenchmarkReport;
}

async function buildFixture(): Promise<{ rootDir: string; sourcePath: string; outDir: string }> {
  const rootDir = await mkdtemp(join(tmpdir(), "preflop-storage-cold-start-"));
  tempDirs.push(rootDir);

  const sourcePath = join(rootDir, "range.db");
  const outDir = join(rootDir, "binary-scheme2");
  const db = new Database(sourcePath);

  try {
    db.exec(`
      CREATE TABLE concrete_lines_default_6max_100BB (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        abstract_line TEXT NOT NULL,
        concrete_line TEXT NOT NULL,
        UNIQUE(abstract_line, concrete_line)
      );

      CREATE TABLE concrete_lines_default_8max_200BB (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        abstract_line TEXT NOT NULL,
        concrete_line TEXT NOT NULL,
        UNIQUE(abstract_line, concrete_line)
      );

      CREATE TABLE drill_scenario_lines_default (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        drill_name TEXT NOT NULL,
        abstract_line TEXT NOT NULL,
        player_count INTEGER NOT NULL,
        depth INTEGER NOT NULL
      );

      CREATE TABLE range_data_default_6max_100BB (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        concrete_line_id INTEGER NOT NULL,
        hole_cards TEXT NOT NULL,
        action_name TEXT NOT NULL,
        action_size REAL NOT NULL,
        amount_bb REAL NOT NULL,
        frequency REAL NOT NULL,
        hand_ev REAL
      );

      CREATE TABLE range_data_default_8max_200BB (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        concrete_line_id INTEGER NOT NULL,
        hole_cards TEXT NOT NULL,
        action_name TEXT NOT NULL,
        action_size REAL NOT NULL,
        amount_bb REAL NOT NULL,
        frequency REAL NOT NULL,
        hand_ev REAL
      );
    `);

    db.query(`
      INSERT INTO concrete_lines_default_6max_100BB(id, abstract_line, concrete_line)
      VALUES (1, 'R-C', 'R2-C')
    `).run();
    db.query(`
      INSERT INTO concrete_lines_default_8max_200BB(id, abstract_line, concrete_line)
      VALUES (1, 'R-C', 'R2-C')
    `).run();
    db.query(`
      INSERT INTO drill_scenario_lines_default(drill_name, abstract_line, player_count, depth)
      VALUES
        ('fixture', 'R-C', 6, 0),
        ('fixture', 'R-C', 8, 0)
    `).run();

    insertRangeRows(db, "range_data_default_6max_100BB");
    insertRangeRows(db, "range_data_default_8max_200BB");
  } finally {
    db.close();
  }

  await buildBinaryStoreScheme2({
    sourceDbPath: sourcePath,
    outDir,
    overwrite: true,
  });

  return { rootDir, sourcePath, outDir };
}

function insertRangeRows(db: Database, tableName: string): void {
  db.query(`
    INSERT INTO ${tableName}(
      concrete_line_id, hole_cards, action_name, action_size, amount_bb, frequency, hand_ev
    )
    VALUES
      (1, 'AA', 'fold', 0, 0, 0.1, 0),
      (1, 'AA', 'call', 0, 0, 0.2, 1),
      (1, 'AA', 'raise', 40, 2, 0.7, 2)
  `).run();
}

async function removeTempDirWithRetry(dir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}
