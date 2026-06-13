import { join } from "node:path";
import { Scheme2BenchmarkRunner, measureScheme2ColdStart } from "../benchmark/runner";
import {
  buildTotals,
  createBenchmarkWorkload,
  getMemorySnapshot,
  measureBenchmarkCase,
  parseRequestedDimension,
  type BenchmarkRunReport,
  writeBenchmarkJson,
  writeBenchmarkMarkdown,
} from "../../benchmark/common";
import { getBooleanArg, getNumberArg, getRepeatedStringArgs, getStringArg, parseCliArgs } from "../../cli/args";

const args = parseCliArgs(Bun.argv.slice(2));

const sourceDbPath = getStringArg(args, "source", "range-db/range.db");
const binaryDir = getStringArg(args, "dir", "range-db/binary-scheme2");
const metaDbPath = getStringArg(args, "meta", join(binaryDir, "meta.db"));
const outPath = getStringArg(args, "out", "reports/benchmark-scheme2.json");
const mdPath = getStringArg(args, "md", "reports/benchmark-scheme2.md");
const seed = getNumberArg(args, "seed", 42);
const defaultIterations = getNumberArg(args, "iterations", 1000);
const handIterations = getNumberArg(args, "hand-iterations", defaultIterations);
const batchIterations = getNumberArg(args, "batch-iterations", Math.min(defaultIterations, 200));
const batchSize = getNumberArg(args, "batch-size", 20);
const warmupIterations = getNumberArg(args, "warmup-iterations", 20);
const verifyChecksums = getBooleanArg(args, "verify-checksum");
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

const runnerOptions = {
  verifyChecksums,
};

const coldStart = await measureScheme2ColdStart({
  metaDbPath,
  binaryDir,
  options: runnerOptions,
  item: workload.handQueries[0],
});
const memoryBefore = getMemorySnapshot();
const runner = new Scheme2BenchmarkRunner(metaDbPath, binaryDir, runnerOptions);

try {
  await runner.warmup(workload.dimensions);

  const cases = [
    await measureBenchmarkCase({
      name: "hand-strategy",
      description: "Single concrete_line_id + hand query through Scheme2QueryService (idx binary search).",
      items: workload.handQueries,
      warmupIterations,
      operation: (item) => runner.getHandStrategy(item),
    }),
    await measureBenchmarkCase({
      name: "batch-hand-strategy",
      description: "Run a batch of concrete_line_id + hand lookups through Scheme2 batch API.",
      items: workload.batchQueries,
      warmupIterations,
      operation: (item) => runner.getHandStrategiesBatch(item),
    }),
  ];

  const memoryAfter = getMemorySnapshot();
  const report: BenchmarkRunReport = {
    generatedAt: new Date().toISOString(),
    engine: "binary",
    sourceDbPath,
    binaryDir,
    metaDbPath,
    options: {
      seed,
      requestedDimensions: requestedDimensionValues,
      handIterations,
      batchIterations,
      batchSize,
      warmupIterations,
      verifyChecksums,
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
      "Cold start includes opening meta.db/idx/bin files and running the first hand query.",
      "Scheme 2 uses .idx files (mmap + binary search) instead of SQLite range_pack_index tables.",
      "Result counts sum decoded action entries so work is consumed rather than only requested.",
    ],
  };

  await writeBenchmarkJson(outPath, report);
  await writeBenchmarkMarkdown(mdPath, report);

  console.log(`Scheme2 benchmark written: ${outPath}`);
  console.log(`Scheme2 benchmark markdown written: ${mdPath}`);

  if (report.totals.errorCount > 0) {
    process.exitCode = 1;
  }
} finally {
  await runner.close();
}
