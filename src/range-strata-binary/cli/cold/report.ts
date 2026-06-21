import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { formatBytes, markdownTable } from "../../../analysis/format";
import type {
  ColdStartBenchmarkReport,
  ColdStartMode,
  ColdStartPhaseSummaries,
  LatencySummary,
  QueryPolicy,
} from "./types";

export async function writeColdStartJson(path: string, reportToWrite: ColdStartBenchmarkReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(reportToWrite, null, 2)}\n`);
}

export async function writeColdStartMarkdown(path: string, reportToWrite: ColdStartBenchmarkReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, renderColdStartMarkdown(reportToWrite));
}

export function buildColdStartNotes(params: {
  queryPolicy: QueryPolicy;
  mode: ColdStartMode;
  cacheFillerSizeBytes: number;
}): string[] {
  const notes = [
    "Each run starts a fresh Bun worker process and records worker phase timings plus parent-observed process elapsed time.",
    "Default dimension selection uses all successful dimensions from manifest.json, so a full production output should cover all 9 dimensions.",
    "storeOpenAndFirstQueryMs = Range Strata Binary store open + dimension prewarm + first query, excluding module/runtime import. Use processElapsedMs or workerTotalMs for end-to-end cold start.",
    "QueryService/native import includes dynamic import of the Range Strata Binary query service and native addon loading.",
    "Dimension prewarm includes opening/mmaping the dimension .idx/.bin files and preloading the action schemas referenced by that dimension.",
    "Parent process overhead is parent-observed process elapsed time minus worker-measured total; it approximates Bun startup/shutdown and IPC overhead.",
    "Phase accounting records the difference between the sum of individual phase timings and workerTotalMs. A discrepancy > 1ms or ratio > 1% should be investigated.",
    `Query policy: ${params.queryPolicy}. Use --query-policy first (default, smoke test) or --query-policy fixed with --concrete-line-id/--hand. Roadmap: round-robin, random, stratified.`,
  ];

  if (params.mode === "process-cold") {
    notes.push("process-cold does not attempt OS page cache eviction; it measures fresh process/open/query cost with whatever cache state the OS currently has.");
  } else if (params.mode === "os-best-effort") {
    notes.push(
      `os-best-effort writes and reads a ${formatBytes(params.cacheFillerSizeBytes)} non-zero filler file to perturb OS page cache. Succeeded means perturbation completed, NOT that .idx/.bin files were evicted. This is a best-effort cache perturbation, not a guaranteed cold cache.`,
    );
  } else {
    notes.push("linux-drop-cache attempts sync + /proc/sys/vm/drop_caches and requires Linux with sufficient privileges.");
  }

  return notes;
}

function renderColdStartMarkdown(reportToRender: ColdStartBenchmarkReport): string {
  const rows = reportToRender.dimensions.map((dimension) => [
    dimension.dimension,
    dimension.runs,
    dimension.errorCount,
    formatMs(dimension.storeOpenAndFirstQueryMs.p50Ms),
    formatMs(dimension.storeOpenAndFirstQueryMs.p95Ms),
    formatMs(dimension.processElapsedMs.p50Ms),
    formatMs(dimension.processElapsedMs.p95Ms),
    formatBytes(dimension.memoryDeltaRssBytes.p95Ms),
    `${dimension.query.concreteLineId} / ${dimension.query.hand}`,
  ]);
  const aggregatePhaseRows = phaseSummaryRows(reportToRender.aggregate.phaseTimings);
  const dimensionPhaseRows = reportToRender.dimensions.map((dimension) => [
    dimension.dimension,
    formatMs(dimension.phaseTimings.queryServiceImportMs.p95Ms),
    formatMs(dimension.phaseTimings.serviceConstructorMs.p95Ms),
    formatMs(dimension.phaseTimings.dimensionPrewarmMs.p95Ms),
    formatMs(dimension.phaseTimings.firstQueryMs.p95Ms),
    formatMs(dimension.phaseTimings.workerTotalMs.p95Ms),
    formatMs(dimension.phaseTimings.processOverheadMs.p95Ms),
  ]);

  return `# Range Strata Binary Cold-Start Benchmark

Generated: ${reportToRender.generatedAt}

## Summary

- Mode: ${reportToRender.mode}
- Platform: ${reportToRender.platform}
- Source DB: \`${reportToRender.sourceDbPath}\`
- Binary dir: \`${reportToRender.binaryDir}\`
- meta.db: \`${reportToRender.metaDbPath}\`
- Dimensions: ${reportToRender.aggregate.dimensions}
- Runs per dimension: ${reportToRender.runsPerDimension}
- Total runs: ${reportToRender.aggregate.runs}
- Errors: ${reportToRender.aggregate.errorCount}
- Cache filler size: ${formatBytes(reportToRender.cacheFillerSizeBytes)}
- Successful runs: ${reportToRender.aggregate.successfulRuns}
- Aggregate store open + first query p50 / p95: ${formatMs(reportToRender.aggregate.storeOpenAndFirstQueryMs.p50Ms)} / ${formatMs(reportToRender.aggregate.storeOpenAndFirstQueryMs.p95Ms)}
- Aggregate process elapsed p50 / p95: ${formatMs(reportToRender.aggregate.processElapsedMs.p50Ms)} / ${formatMs(reportToRender.aggregate.processElapsedMs.p95Ms)}
- Phase accounting (worst): unaccounted ${formatMs(reportToRender.aggregate.phaseAccounting.unaccountedMs)} (${(reportToRender.aggregate.phaseAccounting.unaccountedRatio * 100).toFixed(2)}%)

## Aggregate Phase Breakdown

${markdownTable(["Phase", "P50", "P95", "Avg", "Max"], aggregatePhaseRows)}

## Dimensions

${markdownTable(
  [
    "Dimension",
    "Runs",
    "Errors",
    "Store Open+Query P50",
    "Store Open+Query P95",
    "Process P50",
    "Process P95",
    "RSS Delta P95",
    "Query",
  ],
  rows,
)}

## Failures

${
  reportToRender.aggregate.failures.length === 0
    ? "None\n"
    : markdownTable(
        ["Dimension", "Run", "Exit Code", "Valid JSON", "Error"],
        reportToRender.dimensions.flatMap((dim) =>
          dim.failures.map((failure) =>
            [dim.dimension, failure.runIndex, failure.exitCode, failure.validJson, failure.error].map(String),
          ),
        ),
      )
}

## Dimension Phase Breakdown

${markdownTable(
  [
    "Dimension",
    "QueryService Import P95",
    "Service Ctor P95",
    "Dimension Prewarm P95",
    "First Query P95",
    "Worker Total P95",
    "Process Overhead P95",
  ],
  dimensionPhaseRows,
)}

## Notes

${reportToRender.notes.map((note) => `- ${note}`).join("\n")}
`;
}

function phaseSummaryRows(summary: ColdStartPhaseSummaries): string[][] {
  const rows: Array<[string, LatencySummary]> = [
    ["Support module import", summary.supportModuleImportMs],
    ["CLI args parse", summary.argsParseMs],
    ["QueryService/native import", summary.queryServiceImportMs],
    ["Memory snapshot", summary.memorySnapshotMs],
    ["Service constructor (meta.db open)", summary.serviceConstructorMs],
    ["Dimension prewarm (idx/bin mmap + schema preload)", summary.dimensionPrewarmMs],
    ["First query sync decode", summary.firstQueryMs],
    ["Service close", summary.closeMs],
    ["Worker measured total", summary.workerTotalMs],
    ["Parent process overhead", summary.processOverheadMs],
  ];

  return rows.map(([name, summaryTimings]) => {
    return [
      name,
      formatMs(summaryTimings.p50Ms),
      formatMs(summaryTimings.p95Ms),
      formatMs(summaryTimings.avgMs),
      formatMs(summaryTimings.maxMs),
    ];
  });
}

function formatMs(value: number): string {
  if (!Number.isFinite(value)) return "unknown";
  return `${value.toFixed(value >= 10 ? 2 : 3)} ms`;
}
