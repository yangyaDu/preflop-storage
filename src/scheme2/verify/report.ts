import { writeFileSync } from "node:fs";
import { formatNumber, markdownTable } from "../../analysis/format";

// ── Shared types ──────────────────────────────────────────────

export type VerifyLayer =
  | "file-existence"
  | "manifest"
  | "meta-db"
  | "idx-structure"
  | "bin-structure"
  | "idx-bin-cross"
  | "concrete-idx-consistency"
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
  idxRecords: number;
  binFileSizeBytes: number;
  idxFileSizeBytes: number;
  structureFailures: number;
  idxBinCrossFailures: number;
  sourceCrossFailures?: number;
  sourceCrossRecords?: number;
}

// ── Report ────────────────────────────────────────────────────

export interface Scheme2VerifyReport {
  generatedAt: string;
  mode: "standalone" | "cross";
  directory: string;
  sourceDbPath?: string;
  verifyChecksums: boolean;
  tolerances: {
    frequency: number;
    handEv: number;
  };
  totals: {
    dimensions: number;
    // standalone layers
    manifestOk: boolean;
    metaDbOk: boolean;
    idxFilesOk: number;
    idxFilesFailed: number;
    binFilesOk: number;
    binFilesFailed: number;
    idxBinCrossFailures: number;
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
  extra?: Partial<Pick<Scheme2VerifyReport["totals"], "checkedSourceRecords" | "failedSourceRecords" | "extraBinaryRecords">>,
): Scheme2VerifyReport {
  const structuralFailures = failures.filter((f) => f.layer !== "source-cross");
  const sourceCrossFailures = failures.filter((f) => f.layer === "source-cross");

  const failedIdxs = new Set<string>();
  const failedBins = new Set<string>();
  for (const f of structuralFailures) {
    if (f.layer === "idx-structure" || f.layer === "idx-bin-cross") {
      failedIdxs.add(f.check);
    }
    if (f.layer === "bin-structure") {
      failedBins.add(f.check);
    }
  }

  const totalDims = dimensions.length;
  const checkedDims = dimensions.filter((d) => d.checked);
  const idxFilesOk = checkedDims.filter((d) => {
    const key = `${d.strategy}:${d.playerCount}max:${d.depthBb}BB`;
    return d.structureFailures === 0 && !failedIdxs.has(`dimension:${key}`);
  }).length;
  const idxFilesFailed = checkedDims.length - idxFilesOk;
  const binFilesOk = checkedDims.filter((d) => {
    const key = `${d.strategy}:${d.playerCount}max:${d.depthBb}BB`;
    return !failedBins.has(`dimension:${key}`);
  }).length;
  const binFilesFailed = checkedDims.length - binFilesOk;
  const manifestFailed = failures.some((f) => f.layer === "manifest" || (f.layer === "file-existence" && f.check === "manifest.json"));
  const metaDbFailed = failures.some((f) => f.layer === "meta-db" || (f.layer === "file-existence" && f.check === "meta.db"));

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
    totals: {
      dimensions: totalDims,
      manifestOk: !manifestFailed,
      metaDbOk: !metaDbFailed,
      idxFilesOk,
      idxFilesFailed,
      binFilesOk,
      binFilesFailed,
      idxBinCrossFailures: sourceCrossFailures.length,
      ...extra,
    },
    dimensions,
    failures: failures.slice(0, 200), // cap at a reasonable number
    repairSuggestions: getRepairSuggestions(failures),
  };
}

export function writeJsonReport(report: Scheme2VerifyReport, outPath: string): void {
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8");
}

export function writeMdReport(report: Scheme2VerifyReport, mdPath: string): void {
  const lines: string[] = [
    `# Scheme2 Verify Report`,
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
        ["Meta DB OK", report.totals.metaDbOk ? "YES" : "NO"],
        ["Idx Files OK", `${report.totals.idxFilesOk} / ${report.totals.idxFilesOk + report.totals.idxFilesFailed}`],
        ["Bin Files OK", `${report.totals.binFilesOk} / ${report.totals.binFilesOk + report.totals.binFilesFailed}`],
        ["Idx-Bin Cross Failures", report.totals.idxBinCrossFailures],
        ...(report.mode === "cross"
          ? [
              ["Source Records Checked", report.totals.checkedSourceRecords ?? "N/A"],
              ["Source Records Failed", report.totals.failedSourceRecords ?? "N/A"],
            ]
          : []),
      ],
    ),
    ``,
    `## Tolerances`,
    markdownTable(
      ["Parameter", "Value"],
      [
        ["frequency", `${report.tolerances.frequency}`],
        ["handEV", `${report.tolerances.handEv}`],
      ],
    ),
  ];

  // Dimension details
  if (report.dimensions.length > 0) {
    lines.push(``, `## Dimensions`);
    const dimRows = report.dimensions.map((d) => [
      `${d.strategy}:${d.playerCount}max:${d.depthBb}BB`,
      d.checked ? "YES" : "NO (failed)",
      d.idxRecords,
      d.structureFailures,
      d.idxBinCrossFailures,
      d.sourceCrossRecords ?? "-",
      d.sourceCrossFailures ?? "-",
    ]);
    lines.push(
      markdownTable(
        ["Dimension", "Checked", "Idx Records", "Struct Failures", "Idx-Bin Failures", "Cross Records", "Cross Failures"],
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
  const hasMetaDbIssue = failures.some((f) => f.layer === "meta-db");
  const hasIdxIssue = failures.some((f) => f.layer === "idx-structure" || f.layer === "idx-bin-cross");
  const hasBinIssue = failures.some((f) => f.layer === "bin-structure");
  const hasCrossIssue = failures.some((f) => f.layer === "source-cross");

  if (hasFileMissing) {
    suggestions.push(
      "Some expected files are missing. If dimensions failed during build (status=failed in manifest.json), re-build those dimensions with `--resume`.",
    );
  }
  if (hasManifestIssue) {
    suggestions.push("manifest.json is corrupt or missing required fields. Delete the output directory and re-build from scratch.");
  }
  if (hasMetaDbIssue) {
    suggestions.push("meta.db integrity check failed. Delete the output directory and re-build from scratch — meta.db is regenerated during build.");
  }
  if (hasIdxIssue) {
    suggestions.push(
      ".idx file structure or cross-reference failures detected. These files are generated during build — re-run the build to regenerate them.",
    );
  }
  if (hasBinIssue) {
    suggestions.push(
      ".bin file structure failures detected. These files are generated during build — re-run the build to regenerate them.",
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
