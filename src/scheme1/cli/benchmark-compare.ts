import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { formatBytes, formatPercent, markdownTable, safeRatio } from "../../analysis/format";
import {
  formatMs,
  readBenchmarkReport,
  type BenchmarkCaseResult,
  type BenchmarkRunReport,
} from "../../benchmark/common";
import { getStringArg, parseCliArgs } from "../../cli/args";

interface CaseComparison {
  name: string;
  sqlite: BenchmarkCaseResult | null;
  binary: BenchmarkCaseResult | null;
  binaryToSqliteAvgRatio: number | null;
  binaryToSqliteP95Ratio: number | null;
  binaryToSqliteQpsRatio: number | null;
}

interface BenchmarkCompareReport {
  generatedAt: string;
  sqliteReportPath: string;
  binaryReportPath: string;
  sqliteGeneratedAt: string;
  binaryGeneratedAt: string;
  workloadCompatible: boolean;
  coldStart: {
    sqliteMs: number | null;
    binaryMs: number | null;
    binaryToSqliteRatio: number | null;
  };
  memory: {
    sqliteDeltaRssBytes: number;
    binaryDeltaRssBytes: number;
    sqliteDeltaHeapUsedBytes: number;
    binaryDeltaHeapUsedBytes: number;
  };
  cases: CaseComparison[];
  notes: string[];
}

const args = parseCliArgs(Bun.argv.slice(2));
const sqliteReportPath = getStringArg(args, "sqlite", "reports/benchmark-sqlite.json");
const binaryReportPath = getStringArg(args, "binary", "reports/benchmark-binary.json");
const outPath = getStringArg(args, "out", "reports/benchmark-report.json");
const mdPath = getStringArg(args, "md", "reports/benchmark-report.md");

const sqliteReport = await readBenchmarkReport(sqliteReportPath);
const binaryReport = await readBenchmarkReport(binaryReportPath);
const report = buildCompareReport(sqliteReportPath, binaryReportPath, sqliteReport, binaryReport);

await writeJson(outPath, report);
await writeMarkdown(mdPath, report);

console.log(`Benchmark compare written: ${outPath}`);
console.log(`Benchmark report markdown written: ${mdPath}`);

function buildCompareReport(
  sqliteReportPath: string,
  binaryReportPath: string,
  sqliteReport: BenchmarkRunReport,
  binaryReport: BenchmarkRunReport,
): BenchmarkCompareReport {
  if (sqliteReport.engine !== "sqlite") {
    throw new Error(`Expected SQLite report at ${sqliteReportPath}, got ${sqliteReport.engine}`);
  }
  if (binaryReport.engine !== "binary") {
    throw new Error(`Expected binary report at ${binaryReportPath}, got ${binaryReport.engine}`);
  }

  const caseNames = Array.from(new Set([...sqliteReport.cases, ...binaryReport.cases].map((item) => item.name))).sort();
  const sqliteCases = new Map(sqliteReport.cases.map((item) => [item.name, item]));
  const binaryCases = new Map(binaryReport.cases.map((item) => [item.name, item]));

  return {
    generatedAt: new Date().toISOString(),
    sqliteReportPath,
    binaryReportPath,
    sqliteGeneratedAt: sqliteReport.generatedAt,
    binaryGeneratedAt: binaryReport.generatedAt,
    workloadCompatible: isWorkloadCompatible(sqliteReport, binaryReport),
    coldStart: {
      sqliteMs: sqliteReport.coldStart?.totalMs ?? null,
      binaryMs: binaryReport.coldStart?.totalMs ?? null,
      binaryToSqliteRatio:
        sqliteReport.coldStart && binaryReport.coldStart
          ? safeRatio(binaryReport.coldStart.totalMs, sqliteReport.coldStart.totalMs)
          : null,
    },
    memory: {
      sqliteDeltaRssBytes: sqliteReport.memory.deltaRssBytes,
      binaryDeltaRssBytes: binaryReport.memory.deltaRssBytes,
      sqliteDeltaHeapUsedBytes: sqliteReport.memory.deltaHeapUsedBytes,
      binaryDeltaHeapUsedBytes: binaryReport.memory.deltaHeapUsedBytes,
    },
    cases: caseNames.map((name) => {
      const sqlite = sqliteCases.get(name) ?? null;
      const binary = binaryCases.get(name) ?? null;

      return {
        name,
        sqlite,
        binary,
        binaryToSqliteAvgRatio: sqlite && binary ? safeRatio(binary.avgMs, sqlite.avgMs) : null,
        binaryToSqliteP95Ratio: sqlite && binary ? safeRatio(binary.p95Ms, sqlite.p95Ms) : null,
        binaryToSqliteQpsRatio: sqlite && binary ? safeRatio(binary.qps, sqlite.qps) : null,
      };
    }),
    notes: [
      "Ratio columns use binary / SQLite. Lower latency ratios are better; higher QPS ratios are better.",
      "Cold start does not clear operating-system file cache, so it is process-level cold start rather than machine-level cold storage.",
      "The comparison is workload-compatible only when seed, dimensions, iteration counts, and batch size match.",
    ],
  };
}

function isWorkloadCompatible(sqliteReport: BenchmarkRunReport, binaryReport: BenchmarkRunReport): boolean {
  const sameWorkloadSource = sqliteReport.workloadSource === binaryReport.workloadSource;
  const sameWorkloadPath = sqliteReport.workloadPath === binaryReport.workloadPath;

  return (
    sameWorkloadSource &&
    sameWorkloadPath &&
    sqliteReport.options.seed === binaryReport.options.seed &&
    sqliteReport.workload.handQueries === binaryReport.workload.handQueries &&
    sqliteReport.workload.dimensions.join("\0") === binaryReport.workload.dimensions.join("\0")
  );
}

async function writeJson(path: string, report: BenchmarkCompareReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(report, null, 2)}\n`);
}

async function writeMarkdown(path: string, report: BenchmarkCompareReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, renderMarkdown(report));
}

function renderMarkdown(report: BenchmarkCompareReport): string {
  const caseRows = report.cases.map((item) => [
    item.name,
    item.sqlite ? formatMs(item.sqlite.avgMs) : "N/A",
    item.binary ? formatMs(item.binary.avgMs) : "N/A",
    formatNullableRatio(item.binaryToSqliteAvgRatio),
    item.sqlite ? formatMs(item.sqlite.p95Ms) : "N/A",
    item.binary ? formatMs(item.binary.p95Ms) : "N/A",
    formatNullableRatio(item.binaryToSqliteP95Ratio),
    item.sqlite ? item.sqlite.qps.toFixed(2) : "N/A",
    item.binary ? item.binary.qps.toFixed(2) : "N/A",
    item.binaryToSqliteQpsRatio === null ? "N/A" : `${item.binaryToSqliteQpsRatio.toFixed(2)}x`,
  ]);

  return `# Benchmark 对比报告

生成时间：${report.generatedAt}

## 总览

- SQLite 报告：\`${report.sqliteReportPath}\`
- 二进制报告：\`${report.binaryReportPath}\`
- SQLite 报告生成时间：${report.sqliteGeneratedAt}
- 二进制报告生成时间：${report.binaryGeneratedAt}
- workload 是否一致：${report.workloadCompatible ? "是" : "否"}
- SQLite 冷启动首查：${report.coldStart.sqliteMs === null ? "N/A" : formatMs(report.coldStart.sqliteMs)}
- 二进制冷启动首查：${report.coldStart.binaryMs === null ? "N/A" : formatMs(report.coldStart.binaryMs)}
- 二进制 / SQLite 冷启动：${formatNullableRatio(report.coldStart.binaryToSqliteRatio)}

## 延迟与吞吐

${markdownTable(
  [
    "case",
    "sqlite avg",
    "binary avg",
    "avg ratio",
    "sqlite p95",
    "binary p95",
    "p95 ratio",
    "sqlite qps",
    "binary qps",
    "qps ratio",
  ],
  caseRows,
)}

## 内存

- SQLite RSS 变化：${formatBytes(report.memory.sqliteDeltaRssBytes)}
- 二进制 RSS 变化：${formatBytes(report.memory.binaryDeltaRssBytes)}
- SQLite heap used 变化：${formatBytes(report.memory.sqliteDeltaHeapUsedBytes)}
- 二进制 heap used 变化：${formatBytes(report.memory.binaryDeltaHeapUsedBytes)}

## 说明

${report.notes.map((note) => `- ${note}`).join("\n")}
`;
}

function formatNullableRatio(value: number | null): string {
  return value === null ? "N/A" : formatPercent(value);
}
