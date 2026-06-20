import { writeFileSync } from "node:fs";
import { formatNumber, markdownTable } from "../../analysis/format";
import type { Float32ErrorSample, Float32PrecisionStats } from "../../precision/float32";

// ── Shared types ──────────────────────────────────────────────

export type VerifyLayer =
  | "file-existence"
  | "manifest"
  | "catalog"
  | "index-header"
  | "pack-header"
  | "index-pack-cross"
  | "concrete-index-consistency"
  | "source-cross";

export interface VerifyFailure {
  layer: VerifyLayer;
  check: string;
  reason: string;
  message: string;
  /** Concrete line ID or source row context, if relevant. */
  context?: string;
}

export interface VerifyCheckResult {
  failures: VerifyFailure[];
}

// ── Dimension-level detail ────────────────────────────────────

export interface DimensionVerifyDetail {
  strategy: string;
  playerCount: number;
  depthBb: number;
  /** Whether this dimension was checked at all (status !== "failed" in manifest). */
  checked: boolean;
  indexRecords: number;
  binFileSizeBytes: number;
  idxFileSizeBytes: number;
  headerFailures: number;
  indexPackCrossFailures: number;
  sourceCrossFailures?: number;
  sourceCrossRecords?: number;
}

// ── Report ────────────────────────────────────────────────────

export interface RangeStrataVerifyReport {
  generatedAt: string;
  mode: "standalone" | "cross";
  directory: string;
  sourceDbPath?: string;
  verifyChecksums: boolean;
  tolerances: {
    frequency: number;
    handEv: number;
  };
  precisionPolicy: {
    numericFields: "float32-bit-exact";
    nullableHandEv: "null-or-float32-bit-exact";
  };
  precision?: {
    frequency: Float32PrecisionStats;
    handEv: Float32PrecisionStats;
  };
  totals: {
    dimensions: number;
    // standalone layers
    manifestOk: boolean;
    catalogOk: boolean;
    indexFilesOk: number;
    indexFilesFailed: number;
    packFilesOk: number;
    packFilesFailed: number;
    indexPackCrossFailures: number;
    // cross layer
    checkedSourceRecords?: number;
    failedSourceRecords?: number;
    extraBinaryRecords?: number;
  };
  dimensions: DimensionVerifyDetail[];
  failures: VerifyFailure[];
  repairSuggestions: string[];
}

const FREQUENCY_TOLERANCE = 1e-6;
const HAND_EV_TOLERANCE = 1e-5;

export function createReport(
  mode: "standalone" | "cross",
  directory: string,
  sourceDbPath: string | undefined,
  verifyChecksums: boolean,
  dimensions: DimensionVerifyDetail[],
  failures: VerifyFailure[],
  extra?: Partial<Pick<RangeStrataVerifyReport["totals"], "checkedSourceRecords" | "failedSourceRecords" | "extraBinaryRecords">>,
): RangeStrataVerifyReport {
  const structuralFailures = failures.filter((f) => f.layer !== "source-cross");
  const indexPackCrossFailures = failures.filter((f) => f.layer === "index-pack-cross");

  const failedIdxs = new Set<string>();
  const failedBins = new Set<string>();
  for (const f of structuralFailures) {
    if (f.layer === "index-header" || f.layer === "index-pack-cross") {
      failedIdxs.add(f.check);
    }
    if (f.layer === "pack-header") {
      failedBins.add(f.check);
    }
  }

  const totalDims = dimensions.length;
  const checkedDims = dimensions.filter((d) => d.checked);
  const indexFilesOk = checkedDims.filter((d) => {
    const key = `${d.strategy}:${d.playerCount}max:${d.depthBb}BB`;
    return d.headerFailures === 0 && !failedIdxs.has(`dimension:${key}`);
  }).length;
  const indexFilesFailed = checkedDims.length - indexFilesOk;
  const packFilesOk = checkedDims.filter((d) => {
    const key = `${d.strategy}:${d.playerCount}max:${d.depthBb}BB`;
    return !failedBins.has(`dimension:${key}`);
  }).length;
  const packFilesFailed = checkedDims.length - packFilesOk;
  const manifestFailed = failures.some((f) => f.layer === "manifest" || (f.layer === "file-existence" && f.check === "manifest.json"));
  const catalogFailed = failures.some((f) => f.layer === "catalog" || (f.layer === "file-existence" && f.check === "meta.db"));

  return {
    generatedAt: new Date().toISOString(),
    mode,
    directory,
    sourceDbPath,
    verifyChecksums,
    tolerances: {
      frequency: FREQUENCY_TOLERANCE,
      handEv: HAND_EV_TOLERANCE,
    },
    precisionPolicy: {
      numericFields: "float32-bit-exact",
      nullableHandEv: "null-or-float32-bit-exact",
    },
    totals: {
      dimensions: totalDims,
      manifestOk: !manifestFailed,
      catalogOk: !catalogFailed,
      indexFilesOk,
      indexFilesFailed,
      packFilesOk,
      packFilesFailed,
      indexPackCrossFailures: indexPackCrossFailures.length,
      ...extra,
    },
    dimensions,
    failures: failures.slice(0, 200), // cap at a reasonable number
    repairSuggestions: getRepairSuggestions(failures),
  };
}

export function writeJsonReport(report: RangeStrataVerifyReport, outPath: string): void {
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8");
}

export function writeMdReport(report: RangeStrataVerifyReport, mdPath: string): void {
  const lines: string[] = [
    `# Range Strata Binary Integrity Report`,
    ``,
    `Generated: ${report.generatedAt}`,
    `Mode: ${report.mode}`,
    `Directory: \`${report.directory}\``,
    ...(report.sourceDbPath ? [`Source DB: \`${report.sourceDbPath}\``] : []),
    ``,
    `## Summary`,
    markdownTable(
      ["Metric", "Value"],
      [
        ["Dimensions", formatNumber(report.totals.dimensions)],
        ["Manifest OK", report.totals.manifestOk ? "YES" : "NO"],
        ["Catalog OK", report.totals.catalogOk ? "YES" : "NO"],
        ["Index Files OK", `${report.totals.indexFilesOk} / ${report.totals.indexFilesOk + report.totals.indexFilesFailed}`],
        ["Pack Files OK", `${report.totals.packFilesOk} / ${report.totals.packFilesOk + report.totals.packFilesFailed}`],
        ["Index-Pack Cross Failures", report.totals.indexPackCrossFailures],
        ...(report.mode === "cross"
          ? [
              ["Source Records Checked", report.totals.checkedSourceRecords ?? "N/A"],
              ["Source Records Failed", report.totals.failedSourceRecords ?? "N/A"],
            ]
          : []),
      ],
    ),
    ``,
    `## Precision Policy`,
    markdownTable(
      ["Parameter", "Value"],
      [
        ["numeric fields", report.precisionPolicy.numericFields],
        ["nullable handEV", report.precisionPolicy.nullableHandEv],
        ["legacy frequency tolerance", `${report.tolerances.frequency}`],
        ["legacy handEV tolerance", `${report.tolerances.handEv}`],
      ],
    ),
  ];

  if (report.precision) {
    lines.push(
      ``,
      `## Float32 Quantization`,
      markdownTable(
        [
          "Field",
          "Checked",
          "Nulls",
          "Bit Exact",
          "Mismatches",
          "Max Quantization Abs",
          "P95 Quantization Abs",
          "P99 Quantization Abs",
          "Max Implementation Abs",
        ],
        [
          ["frequency", ...precisionRow(report.precision.frequency)],
          ["handEV", ...precisionRow(report.precision.handEv)],
        ],
      ),
    );

    const topSamples: Array<[string, Float32ErrorSample]> = [
      ...report.precision.frequency.topQuantizationErrors.map((sample): [string, Float32ErrorSample] => ["frequency", sample]),
      ...report.precision.handEv.topQuantizationErrors.map((sample): [string, Float32ErrorSample] => ["handEV", sample]),
    ];

    const topRows = topSamples
      .sort((left, right) => right[1].quantizationAbsError - left[1].quantizationAbsError)
      .slice(0, 20)
      .map(([field, sample]) => [
        field,
        sample.context,
        sample.sourceValue,
        sample.expectedValue,
        sample.actualValue,
        sample.quantizationAbsError,
        sample.implementationAbsError,
        sample.expectedBits,
        sample.actualBits,
      ]);

    if (topRows.length > 0) {
      lines.push(
        ``,
        `## Largest Float32 Quantization Errors`,
        markdownTable(
          ["Field", "Context", "Source", "Expected Float32", "Actual", "Quantization Abs", "Implementation Abs", "Expected Bits", "Actual Bits"],
          topRows,
        ),
      );
    }
  }

  // Dimension details
  if (report.dimensions.length > 0) {
    lines.push(``, `## Dimensions`);
    const dimRows = report.dimensions.map((d) => [
      `${d.strategy}:${d.playerCount}max:${d.depthBb}BB`,
      d.checked ? "YES" : "NO (failed)",
      d.indexRecords,
      d.headerFailures,
      d.indexPackCrossFailures,
      d.sourceCrossRecords ?? "-",
      d.sourceCrossFailures ?? "-",
    ]);
    lines.push(
      markdownTable(
        ["Dimension", "Checked", "Index Records", "Header Failures", "Index-Pack Failures", "Cross Records", "Cross Failures"],
        dimRows,
      ),
    );
  }

  // Failures
  const displayFailures = report.failures.slice(0, 100);
  if (displayFailures.length > 0) {
    const totalFailures = report.failures.length;
    lines.push(``, `## Failures${totalFailures > 100 ? ` (showing first 100 of ${totalFailures})` : ""}`);
    const failureRows = displayFailures.map((f) => [f.layer, f.check, f.reason, f.message.slice(0, 120)]);
    lines.push(markdownTable(["Layer", "Check", "Reason", "Message"], failureRows));
  } else {
    lines.push(``, `## Failures`, `None. All checks passed.`);
  }

  // Suggestions
  if (report.repairSuggestions.length > 0) {
    lines.push(``, `## Repair Suggestions`);
    for (const s of report.repairSuggestions) {
      lines.push(`- ${s}`);
    }
  }

  writeFileSync(mdPath, lines.join("\n"), "utf-8");
}

function precisionRow(stats: Float32PrecisionStats): Array<string | number> {
  return [
    formatNumber(stats.checkedValues),
    formatNumber(stats.nullValues),
    formatNumber(stats.bitExactValues),
    formatNumber(stats.mismatchValues),
    stats.maxQuantizationAbsError,
    stats.p95QuantizationAbsError,
    stats.p99QuantizationAbsError,
    stats.maxImplementationAbsError,
  ];
}

// Error → Reason mapping utility

export interface ReasonGroup {
  reason: string;
  count: number;
}

export function groupReasons(failures: VerifyFailure[], layer: VerifyLayer): ReasonGroup[] {
  const map = new Map<string, number>();
  for (const f of failures) {
    if (f.layer === layer) {
      map.set(f.reason, (map.get(f.reason) ?? 0) + 1);
    }
  }
  return Array.from(map.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

function getRepairSuggestions(failures: VerifyFailure[]): string[] {
  if (failures.length === 0) {
    return ["All checks passed — no repairs needed."];
  }

  const suggestions: string[] = [];

  const hasFileMissing = failures.some((f) => f.reason === "MISSING_FILE");
  const hasManifestIssue = failures.some((f) => f.layer === "manifest");
  const hasCatalogIssue = failures.some((f) => f.layer === "catalog");
  const hasIdxIssue = failures.some((f) => f.layer === "index-header" || f.layer === "index-pack-cross");
  const hasBinIssue = failures.some((f) => f.layer === "pack-header");
  const hasCrossIssue = failures.some((f) => f.layer === "source-cross");

  if (hasFileMissing) {
    suggestions.push(
      "Some expected files are missing. If dimensions failed during build (status=failed in manifest.json), re-build those dimensions with `--resume`.",
    );
  }
  if (hasManifestIssue) {
    suggestions.push("manifest.json is corrupt or missing required fields. Delete the output directory and re-build from scratch.");
  }
  if (hasCatalogIssue) {
    suggestions.push("catalog integrity check failed. Delete the output directory and re-build from scratch — meta.db is regenerated during build.");
  }
  if (hasIdxIssue) {
    suggestions.push(
      "Index header or index-pack cross-reference failures detected. These files are generated during build — re-run the build to regenerate them.",
    );
  }
  if (hasBinIssue) {
    suggestions.push(
      "Pack header failures detected. These files are generated during build — re-run the build to regenerate them.",
    );
  }
  if (hasCrossIssue) {
    suggestions.push(
      "Source cross-validation failures found. Check that the source SQLite DB matches the one used for the last build. Run a full verification with `--verify-checksum` to ensure pack-level CRC32C correctness.",
    );
  }

  if (suggestions.length === 0) {
    suggestions.push("Verify the build was run with compatible software versions.");
  }

  return suggestions;
}
