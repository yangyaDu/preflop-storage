/**
 * @deprecated Scheme1 is retained only for legacy compatibility and SQLite baseline comparison.
 * Use Range Strata Binary analysis and verification paths for new work.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { formatBytes, formatNumber, markdownTable, safeRatio } from "../../analysis/format";
import { parseCliArgs, getStringArg } from "../../cli/args";
import { sum } from "../../utils/math";
import { parseRangeDataTableName, quoteIdentifier } from "../../db/naming";
import { PreflopStoreError } from "../../query/errors";

interface FileSizeInfo {
  path: string;
  exists: boolean;
  bytes: number;
  human: string;
}

interface SqliteColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | number | null;
  pk: number;
}

interface SqliteIndexInfo {
  name: string;
  unique: boolean;
  origin: string;
  partial: boolean;
  columns: string[];
}

interface TableBaseStats {
  name: string;
  kind: "drill" | "concrete" | "range" | "sqlite_internal" | "other";
  rowCount: number;
  columns: SqliteColumnInfo[];
  indexes: SqliteIndexInfo[];
  createSql: string | null;
}

interface ActionDistribution {
  actionName: string;
  rowCount: number;
  concreteLineCount: number;
  handCount: number;
  avgFrequency: number;
}

interface RangeTableStats extends TableBaseStats {
  kind: "range";
  strategy: string;
  playerCount: number;
  depthBb: number;
  concreteLineCount: number;
  handCodeCount: number;
  actionNameCount: number;
  actionSizeCount: number;
  amountBbCount: number;
  handEvNullCount: number;
  avgHoleCardsLength: number;
  avgActionNameLength: number;
  frequency: NumericDistribution;
  handEv: NumericDistribution;
  actionDistribution: ActionDistribution[];
  averageRowsPerConcreteLine: number;
  roughFieldPayloadBytes: number;
  repeatedHoleCardsBytes: number;
  repeatedActionNameBytes: number;
}

interface ConcreteTableStats extends TableBaseStats {
  kind: "concrete";
  strategy: string;
  playerCount: number;
  depthBb: number;
  abstractLineCount: number;
  avgAbstractLineLength: number;
  avgConcreteLineLength: number;
}

interface DrillTableStats extends TableBaseStats {
  kind: "drill";
  strategy: string;
  drillNameCount: number;
  abstractLineCount: number;
  playerCountDistribution: Array<{ playerCount: number; rowCount: number }>;
  depthDistribution: Array<{ depth: number; rowCount: number }>;
}

interface NumericDistribution {
  min: number | null;
  max: number | null;
  avg: number | null;
}

interface SqliteAnalysisReport {
  generatedAt: string;
  sourceDbPath: string;
  files: {
    main: FileSizeInfo;
    shm: FileSizeInfo;
    wal: FileSizeInfo;
    totalBytes: number;
    totalHuman: string;
  };
  database: {
    pageSize: number;
    pageCount: number;
    freelistCount: number;
    reportedBytes: number;
    reportedHuman: string;
  };
  totals: {
    tableCount: number;
    indexCount: number;
    totalRows: number;
    rangeRows: number;
    concreteRows: number;
    drillRows: number;
    roughRangeFieldPayloadBytes: number;
    repeatedHoleCardsBytes: number;
    repeatedActionNameBytes: number;
  };
  tables: TableBaseStats[];
  rangeTables: RangeTableStats[];
  concreteTables: ConcreteTableStats[];
  drillTables: DrillTableStats[];
  notes: string[];
}

const args = parseCliArgs(Bun.argv.slice(2));
const sourceDbPath = getStringArg(args, "source", "range-db/range.db");
const outPath = getStringArg(args, "out", "reports/sqlite-analysis.json");
const mdPath = getStringArg(args, "md", "reports/sqlite-analysis.md");

const report = await analyzeSqlite(sourceDbPath);
await writeJson(outPath, report);
await writeMarkdown(mdPath, report);

console.log(`SQLite analysis written: ${outPath}`);
console.log(`SQLite analysis markdown written: ${mdPath}`);

async function analyzeSqlite(path: string): Promise<SqliteAnalysisReport> {
  const db = new Database(path, { readonly: true });

  try {
    const objects = db
      .query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
      .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
    const tableObjects = objects.filter((object) => object.type === "table");
    const indexObjects = objects.filter((object) => object.type === "index");

    const tableBaseStats: TableBaseStats[] = [];
    const rangeTables: RangeTableStats[] = [];
    const concreteTables: ConcreteTableStats[] = [];
    const drillTables: DrillTableStats[] = [];

    for (const tableObject of tableObjects) {
      const base = getTableBaseStats(db, tableObject.name, tableObject.sql);
      tableBaseStats.push(base);

      if (base.kind === "range") {
        rangeTables.push(getRangeTableStats(db, base));
      } else if (base.kind === "concrete") {
        concreteTables.push(getConcreteTableStats(db, base));
      } else if (base.kind === "drill") {
        drillTables.push(getDrillTableStats(db, base));
      }
    }

    const files = await getDatabaseFiles(path);
    const pageSize = getPragmaNumber(db, "page_size");
    const pageCount = getPragmaNumber(db, "page_count");
    const freelistCount = getPragmaNumber(db, "freelist_count");

    const rangeRows = sum(rangeTables.map((table) => table.rowCount));
    const concreteRows = sum(concreteTables.map((table) => table.rowCount));
    const drillRows = sum(drillTables.map((table) => table.rowCount));

    return {
      generatedAt: new Date().toISOString(),
      sourceDbPath: path,
      files,
      database: {
        pageSize,
        pageCount,
        freelistCount,
        reportedBytes: pageSize * pageCount,
        reportedHuman: formatBytes(pageSize * pageCount),
      },
      totals: {
        tableCount: tableObjects.length,
        indexCount: indexObjects.length,
        totalRows: sum(tableBaseStats.map((table) => table.rowCount)),
        rangeRows,
        concreteRows,
        drillRows,
        roughRangeFieldPayloadBytes: sum(rangeTables.map((table) => table.roughFieldPayloadBytes)),
        repeatedHoleCardsBytes: sum(rangeTables.map((table) => table.repeatedHoleCardsBytes)),
        repeatedActionNameBytes: sum(rangeTables.map((table) => table.repeatedActionNameBytes)),
      },
      tables: tableBaseStats,
      rangeTables,
      concreteTables,
      drillTables,
      notes: [
        "Bun SQLite in this environment does not expose dbstat, so per-table byte sizes are not page-accurate.",
        "roughRangeFieldPayloadBytes is an approximate lower payload estimate, not the real SQLite storage size.",
        "repeatedHoleCardsBytes and repeatedActionNameBytes show repeated string payload pressure in old row-style range tables.",
      ],
    };
  } finally {
    db.close();
  }
}

function getTableBaseStats(db: Database, tableName: string, createSql: string | null): TableBaseStats {
  return {
    name: tableName,
    kind: classifyTable(tableName),
    rowCount: getCount(db, tableName),
    columns: getTableColumns(db, tableName),
    indexes: getTableIndexes(db, tableName),
    createSql,
  };
}

function getRangeTableStats(db: Database, base: TableBaseStats): RangeTableStats {
  const dimension = parseRangeDataTableName(base.name);
  if (!dimension) {
    throw new PreflopStoreError("INVALID_FORMAT", `Range table name could not be parsed: ${base.name}`, {
      tableName: base.name,
    });
  }

  const aggregate = db
    .query(`
      SELECT
        COUNT(DISTINCT concrete_line_id) AS concreteLineCount,
        COUNT(DISTINCT hole_cards) AS handCodeCount,
        COUNT(DISTINCT action_name) AS actionNameCount,
        COUNT(DISTINCT action_size) AS actionSizeCount,
        COUNT(DISTINCT amount_bb) AS amountBbCount,
        SUM(CASE WHEN hand_ev IS NULL THEN 1 ELSE 0 END) AS handEvNullCount,
        AVG(LENGTH(hole_cards)) AS avgHoleCardsLength,
        AVG(LENGTH(action_name)) AS avgActionNameLength,
        MIN(frequency) AS frequencyMin,
        MAX(frequency) AS frequencyMax,
        AVG(frequency) AS frequencyAvg,
        MIN(hand_ev) AS handEvMin,
        MAX(hand_ev) AS handEvMax,
        AVG(hand_ev) AS handEvAvg
      FROM ${quoteIdentifier(base.name)}
    `)
    .get() as {
    concreteLineCount: number;
    handCodeCount: number;
    actionNameCount: number;
    actionSizeCount: number;
    amountBbCount: number;
    handEvNullCount: number;
    avgHoleCardsLength: number;
    avgActionNameLength: number;
    frequencyMin: number | null;
    frequencyMax: number | null;
    frequencyAvg: number | null;
    handEvMin: number | null;
    handEvMax: number | null;
    handEvAvg: number | null;
  };

  const actionDistribution = db
    .query(`
      SELECT
        action_name AS actionName,
        COUNT(*) AS rowCount,
        COUNT(DISTINCT concrete_line_id) AS concreteLineCount,
        COUNT(DISTINCT hole_cards) AS handCount,
        AVG(frequency) AS avgFrequency
      FROM ${quoteIdentifier(base.name)}
      GROUP BY action_name
      ORDER BY rowCount DESC
    `)
    .all() as ActionDistribution[];

  const avgHoleCardsLength = aggregate.avgHoleCardsLength ?? 0;
  const avgActionNameLength = aggregate.avgActionNameLength ?? 0;
  const repeatedHoleCardsBytes = base.rowCount * avgHoleCardsLength;
  const repeatedActionNameBytes = base.rowCount * avgActionNameLength;
  const roughFieldPayloadBytes = base.rowCount * (avgHoleCardsLength + avgActionNameLength + 5 * 8);

  return {
    ...base,
    kind: "range",
    strategy: dimension.strategy,
    playerCount: dimension.playerCount,
    depthBb: dimension.depthBb,
    concreteLineCount: aggregate.concreteLineCount,
    handCodeCount: aggregate.handCodeCount,
    actionNameCount: aggregate.actionNameCount,
    actionSizeCount: aggregate.actionSizeCount,
    amountBbCount: aggregate.amountBbCount,
    handEvNullCount: aggregate.handEvNullCount,
    avgHoleCardsLength,
    avgActionNameLength,
    frequency: {
      min: aggregate.frequencyMin,
      max: aggregate.frequencyMax,
      avg: aggregate.frequencyAvg,
    },
    handEv: {
      min: aggregate.handEvMin,
      max: aggregate.handEvMax,
      avg: aggregate.handEvAvg,
    },
    actionDistribution,
    averageRowsPerConcreteLine: safeRatio(base.rowCount, aggregate.concreteLineCount),
    roughFieldPayloadBytes,
    repeatedHoleCardsBytes,
    repeatedActionNameBytes,
  };
}

function getConcreteTableStats(db: Database, base: TableBaseStats): ConcreteTableStats {
  const match = base.name.match(/^concrete_lines_(.+)_([0-9]+)max_([0-9]+)BB$/);
  if (!match) {
    throw new PreflopStoreError("INVALID_FORMAT", `Concrete table name could not be parsed: ${base.name}`, {
      tableName: base.name,
    });
  }

  const aggregate = db
    .query(`
      SELECT
        COUNT(DISTINCT abstract_line) AS abstractLineCount,
        AVG(LENGTH(abstract_line)) AS avgAbstractLineLength,
        AVG(LENGTH(concrete_line)) AS avgConcreteLineLength
      FROM ${quoteIdentifier(base.name)}
    `)
    .get() as {
    abstractLineCount: number;
    avgAbstractLineLength: number;
    avgConcreteLineLength: number;
  };

  return {
    ...base,
    kind: "concrete",
    strategy: match[1],
    playerCount: Number(match[2]),
    depthBb: Number(match[3]),
    abstractLineCount: aggregate.abstractLineCount,
    avgAbstractLineLength: aggregate.avgAbstractLineLength ?? 0,
    avgConcreteLineLength: aggregate.avgConcreteLineLength ?? 0,
  };
}

function getDrillTableStats(db: Database, base: TableBaseStats): DrillTableStats {
  const match = base.name.match(/^drill_scenario_lines_(.+)$/);
  const aggregate = db
    .query(`
      SELECT
        COUNT(DISTINCT drill_name) AS drillNameCount,
        COUNT(DISTINCT abstract_line) AS abstractLineCount
      FROM ${quoteIdentifier(base.name)}
    `)
    .get() as { drillNameCount: number; abstractLineCount: number };

  const playerCountDistribution = db
    .query(`
      SELECT player_count AS playerCount, COUNT(*) AS rowCount
      FROM ${quoteIdentifier(base.name)}
      GROUP BY player_count
      ORDER BY player_count
    `)
    .all() as Array<{ playerCount: number; rowCount: number }>;

  const depthDistribution = db
    .query(`
      SELECT depth, COUNT(*) AS rowCount
      FROM ${quoteIdentifier(base.name)}
      GROUP BY depth
      ORDER BY depth
    `)
    .all() as Array<{ depth: number; rowCount: number }>;

  return {
    ...base,
    kind: "drill",
    strategy: match?.[1] ?? "unknown",
    drillNameCount: aggregate.drillNameCount,
    abstractLineCount: aggregate.abstractLineCount,
    playerCountDistribution,
    depthDistribution,
  };
}

function classifyTable(tableName: string): TableBaseStats["kind"] {
  if (tableName.startsWith("range_data_")) return "range";
  if (tableName.startsWith("concrete_lines_")) return "concrete";
  if (tableName.startsWith("drill_scenario_lines_")) return "drill";
  if (tableName.startsWith("sqlite_")) return "sqlite_internal";
  return "other";
}

function getCount(db: Database, tableName: string): number {
  const row = db.query(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`).get() as { count: number };
  return row.count;
}

function getTableColumns(db: Database, tableName: string): SqliteColumnInfo[] {
  return db.query(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as SqliteColumnInfo[];
}

function getTableIndexes(db: Database, tableName: string): SqliteIndexInfo[] {
  const rows = db.query(`PRAGMA index_list(${quoteIdentifier(tableName)})`).all() as Array<{
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }>;

  return rows.map((row) => {
    const columns = db
      .query(`PRAGMA index_info(${quoteIdentifier(row.name)})`)
      .all() as Array<{ name: string }>;

    return {
      name: row.name,
      unique: row.unique === 1,
      origin: row.origin,
      partial: row.partial === 1,
      columns: columns.map((column) => column.name),
    };
  });
}

function getPragmaNumber(db: Database, pragmaName: string): number {
  const row = db.query(`PRAGMA ${pragmaName}`).get() as Record<string, number>;
  const value = Object.values(row)[0];
  if (typeof value !== "number") {
    throw new PreflopStoreError("INVALID_FORMAT", `Unexpected PRAGMA ${pragmaName} result`, { pragmaName });
  }
  return value;
}

async function getDatabaseFiles(path: string): Promise<SqliteAnalysisReport["files"]> {
  const main = await getFileSize(path);
  const shm = await getFileSize(`${path}-shm`);
  const wal = await getFileSize(`${path}-wal`);
  const totalBytes = main.bytes + shm.bytes + wal.bytes;

  return {
    main,
    shm,
    wal,
    totalBytes,
    totalHuman: formatBytes(totalBytes),
  };
}

async function getFileSize(path: string): Promise<FileSizeInfo> {
  if (!existsSync(path)) {
    return {
      path,
      exists: false,
      bytes: 0,
      human: formatBytes(0),
    };
  }

  const info = await stat(path);
  return {
    path,
    exists: true,
    bytes: info.size,
    human: formatBytes(info.size),
  };
}

async function writeJson(path: string, report: SqliteAnalysisReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(report, null, 2)}\n`);
}

async function writeMarkdown(path: string, report: SqliteAnalysisReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, renderMarkdown(report));
}

function renderMarkdown(report: SqliteAnalysisReport): string {
  const topRangeRows = [...report.rangeTables]
    .sort((left, right) => right.rowCount - left.rowCount)
    .map((table) => [
      table.name,
      formatNumber(table.rowCount),
      formatNumber(table.concreteLineCount),
      formatNumber(Math.round(table.averageRowsPerConcreteLine)),
      formatBytes(table.roughFieldPayloadBytes),
      formatBytes(table.repeatedHoleCardsBytes + table.repeatedActionNameBytes),
    ]);

  const tableRows = report.tables.map((table) => [
    table.name,
    table.kind,
    formatNumber(table.rowCount),
    table.indexes.length,
  ]);

  return `# SQLite 数据分析报告

生成时间：${report.generatedAt}

## 总览

- 源数据库：\`${report.sourceDbPath}\`
- 主文件大小：${report.files.main.human}
- WAL/SHM 大小：${formatBytes(report.files.wal.bytes + report.files.shm.bytes)}
- 文件总大小：${report.files.totalHuman}
- SQLite page size：${formatNumber(report.database.pageSize)}
- SQLite page count：${formatNumber(report.database.pageCount)}
- 表数量：${formatNumber(report.totals.tableCount)}
- 索引数量：${formatNumber(report.totals.indexCount)}
- 总行数：${formatNumber(report.totals.totalRows)}
- range 行数：${formatNumber(report.totals.rangeRows)}
- concrete line 行数：${formatNumber(report.totals.concreteRows)}
- drill 行数：${formatNumber(report.totals.drillRows)}

## Range 表体积压力

- range 字段 payload 粗估：${formatBytes(report.totals.roughRangeFieldPayloadBytes)}
- 重复 \`hole_cards\` 字符串粗估：${formatBytes(report.totals.repeatedHoleCardsBytes)}
- 重复 \`action_name\` 字符串粗估：${formatBytes(report.totals.repeatedActionNameBytes)}

${markdownTable(
  ["range table", "rows", "concrete lines", "avg rows / line", "rough payload", "repeated strings"],
  topRangeRows,
)}

## 表结构与行数

${markdownTable(["table", "kind", "rows", "indexes"], tableRows)}

## 说明

${report.notes.map((note) => `- ${note}`).join("\n")}
`;
}
