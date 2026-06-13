import {
  buildTotals,
  createBenchmarkWorkload,
  getMemorySnapshot,
  measureBenchmarkCase,
  parseRequestedDimension,
  type BenchmarkRunReport,
} from "../benchmark/common";
import { measureSqliteColdStart, SqliteBenchmarkRunner } from "../benchmark/sqlite-runner";
import { getNumberArg, getRepeatedStringArgs, getStringArg, parseCliArgs } from "./args";

const args = parseCliArgs(Bun.argv.slice(2));

const sourceDbPath = getStringArg(args, "source", "range-db/range.db");
const outPath = getStringArg(args, "out", "reports/benchmark-sqlite.json");
const mdPath = getStringArg(args, "md", "reports/benchmark-sqlite.md");
const seed = getNumberArg(args, "seed", 42);
const defaultIterations = getNumberArg(args, "iterations", 1000);
const handIterations = getNumberArg(args, "hand-iterations", defaultIterations);
const batchIterations = getNumberArg(args, "batch-iterations", Math.min(defaultIterations, 200));
const batchSize = getNumberArg(args, "batch-size", 20);
const warmupIterations = getNumberArg(args, "warmup-iterations", 20);
const requestedDimensionValues = getRepeatedStringArgs(args, "dimension");
const requestedDimensions = requestedDimensionValues.map(parseRequestedDimension);

const workload = createBenchmarkWorkload({
  sourceDbPath,
  requestedDimensions,
  seed,
  handIterations,
  batchIterations,
  batchSize,
});

const coldStart = measureSqliteColdStart(sourceDbPath, workload.handQueries[0]);
const memoryBefore = getMemorySnapshot();
const runner = new SqliteBenchmarkRunner(sourceDbPath);

try {
  const cases = [
    await measureBenchmarkCase({
      name: "hand-strategy",
      description: "Single concrete_line_id + hand query from old SQLite range rows.",
      items: workload.handQueries,
      warmupIterations,
      operation: (item) => runner.getHandStrategy(item),
    }),
    await measureBenchmarkCase({
      name: "batch-hand-strategy",
      description: "Run a batch of concrete_line_id + hand lookups.",
      items: workload.batchQueries,
      warmupIterations,
      operation: (item) => runner.getHandStrategiesBatch(item),
    }),
  ];

  const memoryAfter = getMemorySnapshot();
  const report: BenchmarkRunReport = {
    generatedAt: new Date().toISOString(),
    engine: "sqlite",
    sourceDbPath,
    options: {
      seed,
      requestedDimensions: requestedDimensionValues,
      handIterations,
      batchIterations,
      batchSize,
      warmupIterations,
    },
    workload: {
      dimensions: workload.dimensions,
      handQueries: workload.handQueries.length,
      batchQueries: workload.batchQueries.length,
      batchSize: workload.batchSize,
    },
    coldStart,
    cases,
    totals: buildTotals(cases),
    memory: {
      before: memoryBefore,
      after: memoryAfter,
      deltaRssBytes: memoryAfter.rssBytes - memoryBefore.rssBytes,
      deltaHeapUsedBytes: memoryAfter.heapUsedBytes - memoryBefore.heapUsedBytes,
    },
    notes: [
      "Cold start includes opening the SQLite connection and running the first hand query, but it does not flush the operating-system file cache.",
      "SQLite measurements use the old row-store tables and consume all returned rows so each query is materialized.",
      "Drill random resolves drill_name/player/depth through drill_scenario_lines and concrete_lines before querying the selected hand.",
    ],
  };

  await writeReports(outPath, mdPath, report);
} finally {
  runner.close();
}

async function writeReports(outPath: string, mdPath: string, report: BenchmarkRunReport): Promise<void> {
  const { writeBenchmarkJson, writeBenchmarkMarkdown } = await import("../benchmark/common");
  await writeBenchmarkJson(outPath, report);
  await writeBenchmarkMarkdown(mdPath, report);

  console.log(`SQLite benchmark written: ${outPath}`);
  console.log(`SQLite benchmark markdown written: ${mdPath}`);

  if (report.totals.errorCount > 0) {
    process.exitCode = 1;
  }
}
