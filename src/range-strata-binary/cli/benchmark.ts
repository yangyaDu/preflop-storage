import { join } from "node:path";
import { RangeStrataBenchmarkRunner, measureRangeStrataColdStart } from "../benchmark/runner";
import {
  buildTotals,
  createBenchmarkWorkload,
  getMemorySnapshot,
  measureBenchmarkCase,
  parseRequestedDimension,
  parseWorkloadMode,
  readWorkloadJson,
  type BenchmarkRunReport,
  type BenchmarkWorkload,
  type HandBenchmarkItem,
  writeBenchmarkJson,
  writeBenchmarkMarkdown,
} from "../../benchmark/common";
import { getBooleanArg, getNumberArg, getNumberListArg, getRepeatedStringArgs, getStringArg, parseCliArgs } from "../../cli/args";
import { Database } from "bun:sqlite";
import { quoteIdentifier } from "../../db/naming";

const args = parseCliArgs(Bun.argv.slice(2));

const sourceDbPath = getStringArg(args, "source", "range-db/range.db");
const binaryDir = getStringArg(args, "dir", "range-db/range-strata-binary");
const metaDbPath = getStringArg(args, "meta", join(binaryDir, "meta.db"));
const outPath = getStringArg(args, "out", "reports/benchmark-range-strata-binary.json");
const mdPath = getStringArg(args, "md", "reports/benchmark-range-strata-binary.md");
const workloadPath = args.workload !== undefined && args.workload !== true ? getStringArg(args, "workload") : undefined;
const seed = getNumberArg(args, "seed", 42);
const defaultIterations = getNumberArg(args, "iterations", 1000);
const handIterations = getNumberArg(args, "hand-iterations", defaultIterations);
const batchIterations = getNumberArg(args, "batch-iterations", Math.min(defaultIterations, 200));
const batchSize = getNumberArg(args, "batch-size", 20);
const batchSizes = getNumberListArg(args, "batch-sizes", [1, 5, 10, 50, 100]);
const warmupIterations = getNumberArg(args, "warmup-iterations", 20);
const workloadMode = parseWorkloadMode(getStringArg(args, "workload-mode", "random"));
const verifyChecksums = getBooleanArg(args, "verify-checksum");
const verifyResults = getBooleanArg(args, "verify-results");
const prewarmActionSchemas = getBooleanArg(args, "prewarm-action-schemas");
const requestedDimensionValues = getRepeatedStringArgs(args, "dimension");
const requestedDimensions = requestedDimensionValues.map(parseRequestedDimension);

let workload: BenchmarkWorkload;
let workloadSource: "generated" | "loaded";

if (workloadPath) {
  workload = await readWorkloadJson(workloadPath);
  workloadSource = "loaded";
} else {
  workload = createBenchmarkWorkload({
    sourceDbPath,
    requestedDimensions,
    seed,
    handIterations,
    batchIterations,
    batchSize,
    batchSizes,
    workloadMode,
  });
  workloadSource = "generated";
}

const evictOsCache = getBooleanArg(args, "evict-os-cache");

const runnerOptions = {
  verifyChecksums,
  prewarmActionSchemas,
  evictOsCache,
};

// OS cold start with eviction (if requested)
const coldStart = await measureRangeStrataColdStart({
  metaDbPath,
  binaryDir,
  options: runnerOptions,
  item: workload.handQueries[0],
});

// Second cold start measurement WITHOUT eviction for comparison
const coldStartWarmCache = evictOsCache
  ? await measureRangeStrataColdStart({
      metaDbPath,
      binaryDir,
      options: { ...runnerOptions, evictOsCache: false },
      item: workload.handQueries[0],
    })
  : null;
const memoryBefore = getMemorySnapshot();
const runner = new RangeStrataBenchmarkRunner(metaDbPath, binaryDir, runnerOptions);

try {
  runner.warmup(workload.dimensions);

  const handCase = await measureBenchmarkCase({
    name: "hand-strategy",
    description: "Single concrete_line_id + hand query through RangeStrataQueryService (idx binary search).",
    items: workload.handQueries,
    warmupIterations,
    operation: (item) => runner.getHandStrategy(item),
  });

  const batchCase = await measureBenchmarkCase({
    name: "batch-hand-strategy",
    description: "Run a batch of concrete_line_id + hand lookups through Range Strata Binary batch API (sync).",
    items: workload.batchQueries,
    warmupIterations,
    operation: (item) => runner.getHandStrategiesBatchSync(item),
  });

  // Sequential execution for accurate per-case measurement (avoids concurrent GC pressure)
  const batchSizeCases: Awaited<ReturnType<typeof measureBenchmarkCase>>[] = [];
  for (const [size, queries] of workload.batchQueriesBySize) {
    batchSizeCases.push(
      await measureBenchmarkCase({
        name: `batch-size-${size}`,
        description: `Run ${size} lookups per batch through Range Strata Binary batch API (sync).`,
        items: queries,
        warmupIterations,
        operation: (item) => runner.getHandStrategiesBatchSync(item),
      }),
    );
  }

  const cases = [handCase, batchCase, ...batchSizeCases];

  const memoryAfter = getMemorySnapshot();

  const notes: string[] = [
    "Cold start includes opening meta.db/idx/bin files and running the first hand query.",
    "Range Strata Binary uses .idx files (mmap + binary search) instead of SQLite range_pack_index tables.",
    "Result counts sum decoded action entries so work is consumed rather than only requested.",
  ];

  if (verifyResults) {
    const verifyNotes = await runResultVerification(sourceDbPath, workload.handQueries);
    notes.push(...verifyNotes);
  }

  if (prewarmActionSchemas) {
    notes.push("Action schemas are prewarmed into the RangeStrataQueryService cache before hot measurements.");
  }

  if (coldStart && coldStartWarmCache) {
    const coldMs = coldStart.totalMs;
    const warmMs = coldStartWarmCache.totalMs;
    const diff = coldMs - warmMs;
    const pct = warmMs > 0 ? ((diff / warmMs) * 100).toFixed(1) : "0.0";
    notes.push(
      `OS-cache-evicted cold start: ${coldMs.toFixed(3)} ms. Warm OS cache cold start: ${warmMs.toFixed(3)} ms. ` +
        `Difference: ${diff.toFixed(3)} ms (${pct}% slower). ` +
        "Eviction fills OS file cache with large temp file reads.",
    );
  }

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
      batchSizes,
      warmupIterations,
      verifyChecksums,
      verifyResults,
      prewarmActionSchemas,
      workloadMode: workload.mode,
    },
    workload: {
      dimensions: workload.dimensions,
      handQueries: workload.handQueries.length,
      batchQueries: workload.batchQueries.length,
      batchSize: workload.batchSize,
    },
    workloadSource,
    workloadPath,
    coldStart,
    cases,
    totals: buildTotals(cases),
    memory: {
      before: memoryBefore,
      after: memoryAfter,
      deltaRssBytes: memoryAfter.rssBytes - memoryBefore.rssBytes,
      deltaHeapUsedBytes: memoryAfter.heapUsedBytes - memoryBefore.heapUsedBytes,
    },
    notes,
  };

  await writeBenchmarkJson(outPath, report);
  await writeBenchmarkMarkdown(mdPath, report);

  console.log(`Range Strata Binary benchmark written: ${outPath}`);
  console.log(`Range Strata Binary benchmark markdown written: ${mdPath}`);

  if (report.totals.errorCount > 0) {
    process.exitCode = 1;
  }
} finally {
  await runner.close();
}

function getRangeTableName(item: Pick<HandBenchmarkItem, "strategy" | "playerCount" | "depthBb">): string {
  return `range_data_${item.strategy}_${item.playerCount}max_${item.depthBb}BB`;
}

async function runResultVerification(
  sourceDbPath: string,
  handQueries: HandBenchmarkItem[],
): Promise<string[]> {
  const sampleSize = Math.min(100, handQueries.length);
  const sample = handQueries.slice(0, sampleSize);

  const db = new Database(sourceDbPath, { readonly: true });
  const statements = new Map<string, { all: (...params: unknown[]) => unknown[] }>();

  try {
    let matchCount = 0;
    let mismatchCount = 0;
    let errorCount = 0;
    const mismatches: string[] = [];
    const verificationErrors: string[] = [];

    const runner = new RangeStrataBenchmarkRunner(metaDbPath, binaryDir, runnerOptions);
    try {
      runner.warmup(workload.dimensions);

      for (const item of sample) {
        try {
          const tableName = getRangeTableName(item);
          let stmt = statements.get(tableName);
          if (!stmt) {
            stmt = db.query(`
              SELECT action_name, action_size, amount_bb, frequency, hand_ev
              FROM ${quoteIdentifier(tableName)}
              WHERE concrete_line_id = ?
                AND hole_cards = ?
              ORDER BY action_name, action_size, amount_bb
            `) as { all: (...params: unknown[]) => unknown[] };
            statements.set(tableName, stmt);
          }

          const sqliteRows = stmt.all(item.concreteLineId, item.holeCards);
          const sqliteCount = sqliteRows.length;

          const rangeStrataCount = runner.getHandStrategy(item);

          if (sqliteCount === rangeStrataCount) {
            matchCount++;
          } else {
            mismatchCount++;
            if (mismatches.length < 10) {
              mismatches.push(
                `${item.strategy}_${item.playerCount}max_${item.depthBb}BB / ${item.concreteLineId} / ${item.holeCards}: SQLite=${sqliteCount}, rangeStrata=${rangeStrataCount}`,
              );
            }
          }
        } catch (error) {
          errorCount++;
          if (verificationErrors.length < 10) {
            verificationErrors.push(
              `${item.strategy}_${item.playerCount}max_${item.depthBb}BB / ${item.concreteLineId} / ${item.holeCards}: ${formatUnknownError(error)}`,
            );
          }
        }
      }
    } finally {
      await runner.close();
    }

    const notes: string[] = [];
    notes.push(
      `Result verification (sample size=${sampleSize}): ${matchCount} match, ${mismatchCount} mismatch, ${errorCount} errors.`,
    );

    if (mismatches.length > 0) {
      notes.push(`First ${Math.min(10, mismatches.length)} mismatches: ${mismatches.join("; ")}`);
    }
    if (verificationErrors.length > 0) {
      notes.push(`First ${Math.min(10, verificationErrors.length)} verification errors: ${verificationErrors.join("; ")}`);
    }

    return notes;
  } finally {
    db.close();
  }
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
