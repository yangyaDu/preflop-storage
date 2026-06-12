import { join } from "node:path";
import { BinaryBenchmarkRunner, measureBinaryColdStart } from "../benchmark/binary-runner";
import {
  buildTotals,
  createBenchmarkWorkload,
  getMemorySnapshot,
  measureBenchmarkCase,
  parseRequestedDimension,
  type BenchmarkRunReport,
  writeBenchmarkJson,
  writeBenchmarkMarkdown,
} from "../benchmark/common";
import { getBooleanArg, getNumberArg, getRepeatedStringArgs, getStringArg, parseCliArgs } from "./args";

const args = parseCliArgs(Bun.argv.slice(2));

const sourceDbPath = getStringArg(args, "source", "range-db/range.db");
const binaryDir = getStringArg(args, "dir", "range-db/binary");
const metaDbPath = getStringArg(args, "meta", join(binaryDir, "meta.db"));
const outPath = getStringArg(args, "out", "reports/benchmark-binary.json");
const mdPath = getStringArg(args, "md", "reports/benchmark-binary.md");
const seed = getNumberArg(args, "seed", 42);
const defaultIterations = getNumberArg(args, "iterations", 1000);
const handIterations = getNumberArg(args, "hand-iterations", defaultIterations);
const fullRangeIterations = getNumberArg(args, "full-range-iterations", Math.min(defaultIterations, 200));
const drillIterations = getNumberArg(args, "drill-iterations", Math.min(defaultIterations, 200));
const batchIterations = getNumberArg(args, "batch-iterations", Math.min(defaultIterations, 200));
const batchSize = getNumberArg(args, "batch-size", 20);
const warmupIterations = getNumberArg(args, "warmup-iterations", 20);
const packCacheSize = getNumberArg(args, "pack-cache-size", 1024);
const verifyChecksums = getBooleanArg(args, "verify-checksum");
const requestedDimensionValues = getRepeatedStringArgs(args, "dimension");
const requestedDimensions = requestedDimensionValues.map(parseRequestedDimension);

const workload = createBenchmarkWorkload({
  sourceDbPath,
  requestedDimensions,
  seed,
  handIterations,
  fullRangeIterations,
  drillIterations,
  batchIterations,
  batchSize,
});

const runnerOptions = {
  verifyChecksums,
  packCacheSize,
};

const coldStart = await measureBinaryColdStart({
  metaDbPath,
  binaryDir,
  options: runnerOptions,
  item: workload.handQueries[0],
});
const memoryBefore = getMemorySnapshot();
const runner = new BinaryBenchmarkRunner(metaDbPath, binaryDir, runnerOptions);

try {
  const cases = [
    await measureBenchmarkCase({
      name: "hand-strategy",
      description: "Single concrete_line_id + hand query through PreflopQueryService.",
      items: workload.handQueries,
      warmupIterations,
      operation: (item) => runner.getHandStrategy(item),
    }),
    await measureBenchmarkCase({
      name: "full-range",
      description: "Read and decode all hands/actions for one concrete_line_id.",
      items: workload.fullRangeQueries,
      warmupIterations,
      operation: (item) => runner.getFullRange(item),
    }),
    await measureBenchmarkCase({
      name: "drill-random",
      description: "Resolve drill_name to abstract/concrete lines, then query one hand.",
      items: workload.drillQueries,
      warmupIterations,
      operation: (item) => runner.getDrillScenarioHandStrategies(item),
    }),
    await measureBenchmarkCase({
      name: "batch-hand-strategy",
      description: "Run a batch of concrete_line_id + hand lookups through the SDK batch API.",
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
      fullRangeIterations,
      drillIterations,
      batchIterations,
      batchSize,
      warmupIterations,
      verifyChecksums,
      packCacheSize,
    },
    workload: {
      dimensions: workload.dimensions,
      handQueries: workload.handQueries.length,
      fullRangeQueries: workload.fullRangeQueries.length,
      drillQueries: workload.drillQueries.length,
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
      "Cold start includes opening meta.db/ranges file and running the first hand query, but it does not flush the operating-system file cache.",
      "Hot measurements run after the service is opened; pack cache behavior is controlled by --pack-cache-size.",
      "Result counts sum decoded action entries so work is consumed rather than only requested.",
    ],
  };

  await writeBenchmarkJson(outPath, report);
  await writeBenchmarkMarkdown(mdPath, report);

  console.log(`Binary benchmark written: ${outPath}`);
  console.log(`Binary benchmark markdown written: ${mdPath}`);

  if (report.totals.errorCount > 0) {
    process.exitCode = 1;
  }
} finally {
  await runner.close();
}
