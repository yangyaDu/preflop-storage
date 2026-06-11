import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { formatBytes, formatNumber, formatPercent, markdownTable, safeRatio } from "../analysis/format";
import { quoteIdentifier, getBinFileName } from "../db/naming";
import { parseCliArgs, getStringArg } from "./args";

interface BinaryFileInfo {
  name: string;
  path: string;
  bytes: number;
  human: string;
}

interface DimensionBinaryStats {
  strategy: string;
  playerCount: number;
  depthBb: number;
  binFile: string;
  binFileBytes: number;
  packCount: number;
  actionSchemaCount: number;
  totalHandCount: number;
  avgHandCount: number;
  minHandCount: number;
  maxHandCount: number;
  totalPackBytes: number;
  avgPackBytes: number;
  minPackBytes: number;
  maxPackBytes: number;
  indexToFileBytesRatio: number;
}

interface ActionSchemaStats {
  schemaCount: number;
  totalActionCount: number;
  avgActionCount: number;
  minActionCount: number;
  maxActionCount: number;
}

interface SqliteReportLike {
  files?: {
    totalBytes?: number;
    totalHuman?: string;
  };
  totals?: {
    rangeRows?: number;
  };
}

interface BinaryAnalysisReport {
  generatedAt: string;
  binaryDir: string;
  metaDbPath: string;
  files: {
    metaDb: BinaryFileInfo;
    rangeBins: BinaryFileInfo[];
    totalBytes: number;
    totalHuman: string;
  };
  totals: {
    packCount: number;
    actionSchemaCount: number;
    totalHandCount: number;
    totalPackBytes: number;
    avgPackBytes: number;
    avgHandCount: number;
  };
  actionSchemas: ActionSchemaStats;
  dimensions: DimensionBinaryStats[];
  comparison?: {
    sqliteTotalBytes: number;
    sqliteTotalHuman: string;
    binaryTotalBytes: number;
    binaryTotalHuman: string;
    savedBytes: number;
    savedHuman: string;
    binaryToSqliteRatio: number;
    reductionRatio: number;
    sqliteRangeRows?: number;
  };
  notes: string[];
}

const args = parseCliArgs(Bun.argv.slice(2));
const binaryDir = getStringArg(args, "dir", "range-db/binary");
const metaDbPath = getStringArg(args, "meta", join(binaryDir, "meta.db"));
const outPath = getStringArg(args, "out", "reports/binary-analysis.json");
const mdPath = getStringArg(args, "md", "reports/storage-analysis.md");
const sqliteReportPath = getStringArg(args, "sqlite-report", "reports/sqlite-analysis.json");

const sqliteReport = existsSync(sqliteReportPath) ? await readSqliteReport(sqliteReportPath) : null;
const report = await analyzeBinary(binaryDir, metaDbPath, sqliteReport);
await writeJson(outPath, report);
await writeMarkdown(mdPath, report);

console.log(`Binary analysis written: ${outPath}`);
console.log(`Storage analysis markdown written: ${mdPath}`);

async function analyzeBinary(
  dir: string,
  metaPath: string,
  sqliteReport: SqliteReportLike | null,
): Promise<BinaryAnalysisReport> {
  const db = new Database(metaPath, { readonly: true });

  try {
    const metaDb = await getFileInfo(metaPath);
    const rangeBins = await getRangeBinFiles(dir);
    const totalBytes = metaDb.bytes + sum(rangeBins.map((file) => file.bytes));
    const dimensions = getDimensionStats(db, rangeBins);
    const actionSchemas = getActionSchemaStats(db);
    const totals = getTotals(db);

    return {
      generatedAt: new Date().toISOString(),
      binaryDir: dir,
      metaDbPath: metaPath,
      files: {
        metaDb,
        rangeBins,
        totalBytes,
        totalHuman: formatBytes(totalBytes),
      },
      totals,
      actionSchemas,
      dimensions,
      comparison: sqliteReport?.files?.totalBytes
        ? buildComparison(sqliteReport, totalBytes)
        : undefined,
      notes: [
        "Binary total size counts meta.db plus ranges_*.bin files in the selected directory.",
        "totalPackBytes is read from range_pack_index.byte_length and should be close to range bin file size minus 16-byte headers.",
        "Compression ratio here compares current generated binary data against the source SQLite file size reported by analyze-sqlite.",
      ],
    };
  } finally {
    db.close();
  }
}

interface ParsedIndexTable {
  tableName: string;
  strategy: string;
  playerCount: number;
  depthBb: number;
  binFile: string;
}

function getIndexTables(db: Database): ParsedIndexTable[] {
  const tableRows = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'range_pack_index_%' ORDER BY name")
    .all() as Array<{ name: string }>;

  const pattern = /^range_pack_index_(.+)_([0-9]+)max_([0-9]+)BB$/;
  const results: ParsedIndexTable[] = [];

  for (const row of tableRows) {
    const match = row.name.match(pattern);
    if (!match) continue;
    const [, strategy, playerCountText, depthBbText] = match;
    const playerCount = Number(playerCountText);
    const depthBb = Number(depthBbText);
    results.push({
      tableName: row.name,
      strategy,
      playerCount,
      depthBb,
      binFile: getBinFileName(strategy, playerCount, depthBb),
    });
  }

  return results;
}

function getDimensionStats(db: Database, rangeBins: BinaryFileInfo[]): DimensionBinaryStats[] {
  const fileBytesByName = new Map(rangeBins.map((file) => [file.name, file.bytes]));
  const rows: DimensionBinaryStats[] = [];

  for (const info of getIndexTables(db)) {
    const stats = db
      .query(`
        SELECT
          COUNT(*) AS packCount,
          COUNT(DISTINCT action_schema_id) AS actionSchemaCount,
          SUM(hand_count) AS totalHandCount,
          AVG(hand_count) AS avgHandCount,
          MIN(hand_count) AS minHandCount,
          MAX(hand_count) AS maxHandCount,
          SUM(byte_length) AS totalPackBytes,
          AVG(byte_length) AS avgPackBytes,
          MIN(byte_length) AS minPackBytes,
          MAX(byte_length) AS maxPackBytes
        FROM ${quoteIdentifier(info.tableName)}
      `)
      .get() as {
        packCount: number;
        actionSchemaCount: number;
        totalHandCount: number | null;
        avgHandCount: number | null;
        minHandCount: number | null;
        maxHandCount: number | null;
        totalPackBytes: number | null;
        avgPackBytes: number | null;
        minPackBytes: number | null;
        maxPackBytes: number | null;
      };

    if (stats.packCount === 0) continue;

    const binFileBytes = fileBytesByName.get(info.binFile) ?? 0;
    const totalPackBytes = stats.totalPackBytes ?? 0;

    rows.push({
      strategy: info.strategy,
      playerCount: info.playerCount,
      depthBb: info.depthBb,
      binFile: info.binFile,
      binFileBytes,
      packCount: stats.packCount,
      actionSchemaCount: stats.actionSchemaCount,
      totalHandCount: stats.totalHandCount ?? 0,
      avgHandCount: stats.avgHandCount ?? 0,
      minHandCount: stats.minHandCount ?? 0,
      maxHandCount: stats.maxHandCount ?? 0,
      totalPackBytes,
      avgPackBytes: stats.avgPackBytes ?? 0,
      minPackBytes: stats.minPackBytes ?? 0,
      maxPackBytes: stats.maxPackBytes ?? 0,
      indexToFileBytesRatio: safeRatio(totalPackBytes, binFileBytes),
    });
  }

  return rows;
}

function getActionSchemaStats(db: Database): ActionSchemaStats {
  const row = db
    .query(`
      SELECT
        COUNT(*) AS schemaCount,
        SUM(action_count) AS totalActionCount,
        AVG(action_count) AS avgActionCount,
        MIN(action_count) AS minActionCount,
        MAX(action_count) AS maxActionCount
      FROM action_schemas
    `)
    .get() as ActionSchemaStats;

  return {
    schemaCount: row.schemaCount ?? 0,
    totalActionCount: row.totalActionCount ?? 0,
    avgActionCount: row.avgActionCount ?? 0,
    minActionCount: row.minActionCount ?? 0,
    maxActionCount: row.maxActionCount ?? 0,
  };
}

function getTotals(db: Database): BinaryAnalysisReport["totals"] {
  let packCount = 0;
  let actionSchemaCount = 0;
  let totalHandCount = 0;
  let totalPackBytes = 0;

  for (const info of getIndexTables(db)) {
    const row = db
      .query(`
        SELECT
          COUNT(*) AS packCount,
          COUNT(DISTINCT action_schema_id) AS actionSchemaCount,
          SUM(hand_count) AS totalHandCount,
          SUM(byte_length) AS totalPackBytes
        FROM ${quoteIdentifier(info.tableName)}
      `)
      .get() as {
      packCount: number | null;
      actionSchemaCount: number | null;
      totalHandCount: number | null;
      totalPackBytes: number | null;
    };

    packCount += row.packCount ?? 0;
    actionSchemaCount += row.actionSchemaCount ?? 0;
    totalHandCount += row.totalHandCount ?? 0;
    totalPackBytes += row.totalPackBytes ?? 0;
  }

  return {
    packCount,
    actionSchemaCount,
    totalHandCount,
    totalPackBytes,
    avgPackBytes: safeRatio(totalPackBytes, packCount),
    avgHandCount: safeRatio(totalHandCount, packCount),
  };
}

function buildComparison(sqliteReport: SqliteReportLike, binaryTotalBytes: number): BinaryAnalysisReport["comparison"] {
  const sqliteTotalBytes = sqliteReport.files?.totalBytes ?? 0;
  const savedBytes = Math.max(sqliteTotalBytes - binaryTotalBytes, 0);
  return {
    sqliteTotalBytes,
    sqliteTotalHuman: sqliteReport.files?.totalHuman ?? formatBytes(sqliteTotalBytes),
    binaryTotalBytes,
    binaryTotalHuman: formatBytes(binaryTotalBytes),
    savedBytes,
    savedHuman: formatBytes(savedBytes),
    binaryToSqliteRatio: safeRatio(binaryTotalBytes, sqliteTotalBytes),
    reductionRatio: safeRatio(savedBytes, sqliteTotalBytes),
    sqliteRangeRows: sqliteReport.totals?.rangeRows,
  };
}

async function getRangeBinFiles(dir: string): Promise<BinaryFileInfo[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: BinaryFileInfo[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".bin")) continue;
    files.push(await getFileInfo(join(dir, entry.name)));
  }

  return files.sort((left, right) => left.name.localeCompare(right.name));
}

async function getFileInfo(path: string): Promise<BinaryFileInfo> {
  const info = await stat(path);
  return {
    name: path.split(/[\\/]/).at(-1) ?? path,
    path,
    bytes: info.size,
    human: formatBytes(info.size),
  };
}

async function readSqliteReport(path: string): Promise<SqliteReportLike> {
  const text = await Bun.file(path).text();
  return JSON.parse(text) as SqliteReportLike;
}

async function writeJson(path: string, report: BinaryAnalysisReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(report, null, 2)}\n`);
}

async function writeMarkdown(path: string, report: BinaryAnalysisReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, renderMarkdown(report));
}

function renderMarkdown(report: BinaryAnalysisReport): string {
  const comparison = report.comparison
    ? `## 体积对比

- 旧 SQLite 总大小：${report.comparison.sqliteTotalHuman}
- 新二进制总大小：${report.comparison.binaryTotalHuman}
- 节省体积：${report.comparison.savedHuman}
- 新格式 / 旧格式：${formatPercent(report.comparison.binaryToSqliteRatio)}
- 降幅：${formatPercent(report.comparison.reductionRatio)}
- SQLite range 行数：${report.comparison.sqliteRangeRows === undefined ? "unknown" : formatNumber(report.comparison.sqliteRangeRows)}
`
    : "## 体积对比\n\n未提供 SQLite 分析报告，跳过新旧体积对比。\n";

  const dimensionRows = report.dimensions.map((dimension) => [
    `${dimension.strategy} ${dimension.playerCount}max ${dimension.depthBb}BB`,
    dimension.binFile,
    formatBytes(dimension.binFileBytes),
    formatNumber(dimension.packCount),
    formatNumber(dimension.actionSchemaCount),
    dimension.avgHandCount.toFixed(2),
    formatBytes(dimension.avgPackBytes),
  ]);

  return `# 存储分析报告

生成时间：${report.generatedAt}

## 新格式总览

- 二进制目录：\`${report.binaryDir}\`
- meta.db：${report.files.metaDb.human}
- ranges 文件数量：${formatNumber(report.files.rangeBins.length)}
- 新格式总大小：${report.files.totalHuman}
- pack 数量：${formatNumber(report.totals.packCount)}
- action schema 数量：${formatNumber(report.totals.actionSchemaCount)}
- 平均 pack 大小：${formatBytes(report.totals.avgPackBytes)}
- 平均 hand 数：${report.totals.avgHandCount.toFixed(2)}

${comparison}

## 维度分布

${markdownTable(
  ["dimension", "bin file", "file size", "packs", "schemas", "avg hands", "avg pack"],
  dimensionRows,
)}

## Action Schema

- schema 数量：${formatNumber(report.actionSchemas.schemaCount)}
- action 总数：${formatNumber(report.actionSchemas.totalActionCount)}
- 平均 action 数：${report.actionSchemas.avgActionCount.toFixed(2)}
- 最少 action 数：${formatNumber(report.actionSchemas.minActionCount)}
- 最多 action 数：${formatNumber(report.actionSchemas.maxActionCount)}

## 说明

${report.notes.map((note) => `- ${note}`).join("\n")}
`;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}


