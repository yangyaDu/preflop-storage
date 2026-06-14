import { join } from "node:path";
import { Scheme2BenchmarkRunner, measureScheme2ColdStart } from "../benchmark/runner";
import {
  buildTotals,
  createBenchmarkWorkload,
  getMemorySnapshot,
  measureBenchmarkCase,
  parseRequestedDimension,
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
const binaryDir = getStringArg(args, "dir", "range-db/binary-scheme2");
const metaDbPath = getStringArg(args, "meta", join(binaryDir, "meta.db"));
const outPath = getStringArg(args, "out", "reports/benchmark-scheme2.json");
const mdPath = getStringArg(args, "md", "reports/benchmark-scheme2.md");
const workloadPath = args.workload !== undefined && args.workload !== true ? getStringArg(args, "workload") : undefined;
const seed = getNumberArg(args, "seed", 42);
const defaultIterations = getNumberArg(args, "iterations", 1000);
const handIterations = getNumberArg(args, "hand-iterations", defaultIterations);
const batchIterations = getNumberArg(args, "batch-iterations", Math.min(defaultIterations, 200));
const batchSize = getNumberArg(args, "batch-size", 20);
const batchSizes = getNumberListArg(args, "batch-sizes", [1, 5, 10, 50, 100]);
const warmupIterations = getNumberArg(args, "warmup-iterations", 20);
const verifyChecksums = getBooleanArg(args, "verify-checksum");
const verifyResults = getBooleanArg(args, "verify-results");
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
  });
  workloadSource = "generated";
}

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
  runner.warmup(workload.dimensions);

  const handCase = await measureBenchmarkCase({
    name: "hand-strategy",
    description: "Single concrete_line_id + hand query through Scheme2QueryService (idx binary search).",
    items: workload.handQueries,
    warmupIterations,
    operation: (item) => runner.getHandStrategy(item),
  });

  const batchCase = await measureBenchmarkCase({
    name: "batch-hand-strategy",
    description: "Run a batch of concrete_line_id + hand lookups through Scheme2 batch API.",
    items: workload.batchQueries,
    warmupIterations,
    operation: (item) => runner.getHandStrategiesBatch(item),
  });

  const batchSizeCases = await Promise.all(
    [...workload.batchQueriesBySize.entries()].map(([size, queries]) =>
      measureBenchmarkCase({
        name: `batch-size-${size}`,
        description: `Run ${size} lookups per batch through Scheme2 batch API.`,
        items: queries,
        warmupIterations,
        operation: (item) => runner.getHandStrategiesBatch(item),
      }),
    ),
  );

  const cases = [handCase, batchCase, ...batchSizeCases];

  const memoryAfter = getMemorySnapshot();

  const notes: string[] = [
    "Cold start includes opening meta.db/idx/bin files and running the first hand query.",
    "Scheme 2 uses .idx files (mmap + binary search) instead of SQLite range_pack_index tables.",
    "Result counts sum decoded action entries so work is consumed rather than only requested.",
  ];

  if (verifyResults) {
    const verifyNotes = await runResultVerification(sourceDbPath, workload.handQueries);
    notes.push(...verifyNotes);
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

  console.log(`Scheme2 benchmark written: ${outPath}`);
  console.log(`Scheme2 benchmark markdown written: ${mdPath}`);

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

    const runner = new Scheme2BenchmarkRunner(metaDbPath, binaryDir, runnerOptions);
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

          const scheme2Count = runner.getHandStrategy(item);

          if (sqliteCount === scheme2Count) {
            matchCount++;
          } else {
            mismatchCount++;
            if (mismatches.length < 10) {
              mismatches.push(
                `${item.strategy}_${item.playerCount}max_${item.depthBb}BB / ${item.concreteLineId} / ${item.holeCards}: SQLite=${sqliteCount}, scheme2=${scheme2Count}`,
              );
            }
          }
        } catch {
          errorCount++;
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

    return notes;
  } finally {
    db.close();
  }
}
