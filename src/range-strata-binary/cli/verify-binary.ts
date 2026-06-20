import {
  getBooleanArg,
  getNumberArg,
  getStringArg,
  parseCliArgs,
} from "../../cli/args";
import { runStandaloneVerify } from "../verify/standalone";
import { runCrossVerify } from "../verify/cross";

type VerifyMode = "standalone" | "cross";

function parseMode(value: string): VerifyMode {
  if (value === "standalone" || value === "cross") return value;
  throw new Error(`Invalid --mode value: ${value}. Use standalone or cross.`);
}

const args = parseCliArgs(Bun.argv.slice(2));

const mode = parseMode(getStringArg(args, "mode", "standalone"));
const dir = getStringArg(args, "dir", "range-db/range-strata-binary");
const sourceDbPath = mode === "cross" ? getStringArg(args, "source", "range-db/range.db") : undefined;
const verifyChecksums = getBooleanArg(args, "verify-checksum");
const sampleSize = getNumberArg(args, "sample-size", mode === "cross" ? 10000 : 0);
const maxFailures = getNumberArg(args, "max-failures", 50);

const outPath = getStringArg(
  args,
  "out",
  mode === "cross"
    ? `reports/range-strata-verify-cross.json`
    : `reports/range-strata-verify-standalone.json`,
);
const mdPath = getStringArg(
  args,
  "md",
  mode === "cross"
    ? `reports/range-strata-verify-cross.md`
    : `reports/range-strata-verify-standalone.md`,
);

async function main() {
  if (mode === "standalone") {
    const report = await runStandaloneVerify({
      dir,
      verifyChecksums,
      outPath,
      mdPath,
    });

    console.log(`Range Strata Binary standalone verification complete.`);
    console.log(`  Dimensions: ${report.totals.dimensions}`);
    console.log(`  Manifest OK: ${report.totals.manifestOk}`);
    console.log(`  Meta DB OK: ${report.totals.metaDbOk}`);
    console.log(`  Idx files OK: ${report.totals.idxFilesOk}/${report.totals.idxFilesOk + report.totals.idxFilesFailed}`);
    console.log(`  Bin files OK: ${report.totals.binFilesOk}/${report.totals.binFilesOk + report.totals.binFilesFailed}`);
    console.log(`  Idx-Bin cross failures: ${report.totals.idxBinCrossFailures}`);
    console.log(`  Total failures: ${report.failures.length}`);

    const hasFailure =
      !report.totals.manifestOk ||
      !report.totals.metaDbOk ||
      report.totals.idxFilesFailed > 0 ||
      report.totals.binFilesFailed > 0 ||
      report.totals.idxBinCrossFailures > 0;

    if (hasFailure) {
      process.exitCode = 1;
    }
  } else {
    if (!sourceDbPath) {
      throw new Error("--source is required for cross mode");
    }

    const report = await runCrossVerify({
      dir,
      sourceDbPath,
      sampleSize,
      maxFailures,
      verifyChecksums,
      outPath,
      mdPath,
    });

    console.log(`Range Strata Binary cross verification complete.`);
    console.log(`  Dimensions: ${report.totals.dimensions}`);
    console.log(`  Manifest OK: ${report.totals.manifestOk}`);
    console.log(`  Meta DB OK: ${report.totals.metaDbOk}`);
    console.log(`  Idx files OK: ${report.totals.idxFilesOk}/${report.totals.idxFilesOk + report.totals.idxFilesFailed}`);
    console.log(`  Source records checked: ${report.totals.checkedSourceRecords ?? "N/A"}`);
    console.log(`  Source records failed: ${report.totals.failedSourceRecords ?? "N/A"}`);
    console.log(`  Extra binary records: ${report.totals.extraBinaryRecords ?? "N/A"}`);
    console.log(`  Total failures: ${report.failures.length}`);

    const hasFailure =
      !report.totals.manifestOk ||
      !report.totals.metaDbOk ||
      report.totals.idxFilesFailed > 0 ||
      report.totals.binFilesFailed > 0 ||
      (report.totals.failedSourceRecords ?? 0) > 0 ||
      (report.totals.extraBinaryRecords ?? 0) > 0;

    if (hasFailure) {
      process.exitCode = 1;
    }
  }
}

// Top-level await
await main();
