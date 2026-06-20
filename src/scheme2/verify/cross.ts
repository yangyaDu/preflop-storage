import { runStandaloneVerify } from "./standalone";
import { runSourceCross } from "./checks/source-cross";
import type { BuildManifest } from "../importer/build-types";
import { createReport, writeJsonReport, writeMdReport, type Scheme2VerifyReport, type VerifyFailure } from "./report";

export interface CrossVerifyOptions {
  dir: string;
  sourceDbPath: string;
  sampleSize: number;
  maxFailures: number;
  verifyChecksums: boolean;
  outPath?: string;
  mdPath?: string;
}

export async function runCrossVerify(options: CrossVerifyOptions): Promise<Scheme2VerifyReport> {
  const { dir, sourceDbPath, sampleSize, maxFailures, verifyChecksums } = options;

  // Step 1: run standalone checks first
  const standaloneReport = await runStandaloneVerify({
    dir,
    verifyChecksums: true,
    // Don't write standalone reports — we'll produce a combined cross report
  });

  // Check if standalone found fatal issues
  const hasFileIssues = standaloneReport.failures.some(
    (f) => f.layer === "manifest" || f.layer === "meta-db" || f.reason === "MISSING_FILE",
  );

  if (hasFileIssues) {
    // Still try cross validation, but mark it as partial
    console.warn("Warning: standalone checks found issues. Cross-validation may be incomplete.");
  }

  // Step 2: run source DB cross-validation
  let manifest: BuildManifest;
  try {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8"));
  } catch {
    // manifest.json is already broken — reuse standalone report
    return {
      ...standaloneReport,
      mode: "cross",
      sourceDbPath,
    };
  }

  const crossResult = runSourceCross({
    sourceDbPath,
    dir,
    manifest,
    sampleSize,
    maxFailures,
  });

  // Merge failures
  const allFailures: VerifyFailure[] = [
    ...standaloneReport.failures.filter((f) => f.layer !== "source-cross"),
    ...crossResult.failures,
  ];

  // Update dimension details with cross info
  const dimensions = standaloneReport.dimensions.map((d) => ({
    ...d,
    sourceCrossRecords: d.checked ? undefined : undefined,
    sourceCrossFailures: d.checked ? undefined : undefined,
  }));

  const report = createReport(
    "cross",
    dir,
    sourceDbPath,
    verifyChecksums,
    dimensions,
    allFailures,
    {
      checkedSourceRecords: crossResult.checkedRecords,
      failedSourceRecords: crossResult.failedRecords,
      extraBinaryRecords: crossResult.extraBinaryRecords,
    },
  );

  // Override totals with cross-specific data
  report.totals.checkedSourceRecords = crossResult.checkedRecords;
  report.totals.failedSourceRecords = crossResult.failedRecords;
  report.totals.extraBinaryRecords = crossResult.extraBinaryRecords;
  report.precision = crossResult.precision;

  // Write reports
  if (options.outPath) {
    try {
      writeJsonReport(report, options.outPath);
      console.log(`JSON report written to ${options.outPath}`);
    } catch (e) {
      console.error(`Failed to write JSON report: ${e}`);
    }
  }
  if (options.mdPath) {
    try {
      writeMdReport(report, options.mdPath);
      console.log(`Markdown report written to ${options.mdPath}`);
    } catch (e) {
      console.error(`Failed to write Markdown report: ${e}`);
    }
  }

  return report;
}
