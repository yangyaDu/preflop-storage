import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decodeActionSchema, normalizeActionName, type ActionDef } from "../../binary/action-schema-codec";
import { assertCrc32c } from "../../binary/crc32c";
import { RangeBinReader } from "../../binary/range-bin-reader";
import { decodeRangePack, type DecodedRangePack } from "../../binary/range-pack-codec";
import { formatNumber, markdownTable } from "../../analysis/format";
import {
  dimensionKey,
  getBinFileName,
  getRangePackIndexTableName,
  quoteIdentifier,
  type RangeDimension,
} from "../../db/naming";
import { getHandId } from "../../hand/hand-dict";
import { discoverRangeDimensions, type OldRangeRow } from "../../importer/old-sqlite";
import { getNumberArg, getRepeatedStringArgs, getStringArg, parseCliArgs } from "../../cli/args";

type VerifyMode = "sample" | "full";

interface RequestedDimension {
  strategy: string;
  playerCount: number;
  depthBb: number;
}

interface VerifyOptions {
  sourceDbPath: string;
  binaryDir: string;
  metaDbPath: string;
  mode: VerifyMode;
  sampleSize: number;
  maxFailures: number;
  dimensions: RequestedDimension[];
}

interface DecodedPackContext {
  actions: ActionDef[];
  decoded: DecodedRangePack;
  handIndexById: Map<number, number>;
  existingCellCount: number;
}

interface VerifyFailure {
  dimension: string;
  concreteLineId: number;
  holeCards?: string;
  actionName?: string;
  reason: string;
  details: string;
}

interface DimensionVerifyStats {
  dimension: string;
  checkedConcreteLines: number;
  checkedOldRecords: number;
  successOldRecords: number;
  failedOldRecords: number;
  extraBinaryRecords: number;
  packReadFailures: number;
  maxFrequencyError: number;
  maxHandEvError: number;
}

interface VerifyReport {
  generatedAt: string;
  sourceDbPath: string;
  binaryDir: string;
  metaDbPath: string;
  mode: VerifyMode;
  sampleSize?: number;
  tolerances: {
    actionSize: number;
    amountBB: number;
    frequency: number;
    handEV: number;
  };
  totals: {
    dimensions: number;
    checkedConcreteLines: number;
    checkedOldRecords: number;
    successOldRecords: number;
    failedOldRecords: number;
    extraBinaryRecords: number;
    failedRecords: number;
    packReadFailures: number;
    maxFrequencyError: number;
    maxHandEvError: number;
  };
  dimensions: DimensionVerifyStats[];
  failures: VerifyFailure[];
  repairSuggestions: string[];
}

interface RangePackIndexRow {
  action_schema_id: number;
  hand_count: number;
  offset: number;
  byte_length: number;
  checksum: number;
}

const ACTION_VALUE_TOLERANCE = 1e-6;
const FREQUENCY_TOLERANCE = 1e-6;
const HAND_EV_TOLERANCE = 1e-5;

const args = parseCliArgs(Bun.argv.slice(2));
const mode = parseMode(getStringArg(args, "mode", "sample"));
const binaryDir = getStringArg(args, "dir", "range-db/binary");

const options: VerifyOptions = {
  sourceDbPath: getStringArg(args, "source", "range-db/range.db"),
  binaryDir,
  metaDbPath: getStringArg(args, "meta", join(binaryDir, "meta.db")),
  mode,
  sampleSize: getNumberArg(args, "sample-size", 10000),
  maxFailures: getNumberArg(args, "max-failures", 50),
  dimensions: getRepeatedStringArgs(args, "dimension").map(parseDimension),
};

const outPath = getStringArg(
  args,
  "out",
  mode === "full" ? "reports/verify-full.json" : "reports/verify-sample.json",
);
const mdPath = getStringArg(
  args,
  "md",
  mode === "full" ? "reports/verify-full.md" : "reports/verify-sample.md",
);

const report = await verifyBinary(options);
await writeJson(outPath, report);
await writeMarkdown(mdPath, report);

console.log(`Binary verification written: ${outPath}`);
console.log(`Binary verification markdown written: ${mdPath}`);

if (report.totals.failedRecords > 0 || report.totals.packReadFailures > 0) {
  process.exitCode = 1;
}

async function verifyBinary(options: VerifyOptions): Promise<VerifyReport> {
  const sourceDb = new Database(options.sourceDbPath, { readonly: true });
  const metaDb = new Database(options.metaDbPath, { readonly: true });
  const readers = new Map<string, RangeBinReader>();
  const actionSchemaCache = new Map<number, ActionDef[]>();

  try {
    const dimensions = filterDimensions(discoverRangeDimensions(sourceDb), options.dimensions);
    const stats: DimensionVerifyStats[] = [];
    const failures: VerifyFailure[] = [];
    const quotas = options.mode === "sample" ? getSampleQuotas(sourceDb, dimensions, options.sampleSize) : new Map<string, number>();

    for (const dimension of dimensions) {
      stats.push(
        await verifyDimension({
          sourceDb,
          metaDb,
          readers,
          actionSchemaCache,
          binaryDir: options.binaryDir,
          dimension,
          mode: options.mode,
          sampleQuota: quotas.get(dimensionKey(dimension)) ?? 0,
          maxFailures: options.maxFailures,
          failures,
        }),
      );
    }

    const totals = mergeStats(stats);
    const failedRecords = totals.failedOldRecords + totals.extraBinaryRecords;

    return {
      generatedAt: new Date().toISOString(),
      sourceDbPath: options.sourceDbPath,
      binaryDir: options.binaryDir,
      metaDbPath: options.metaDbPath,
      mode: options.mode,
      sampleSize: options.mode === "sample" ? options.sampleSize : undefined,
      tolerances: {
        actionSize: ACTION_VALUE_TOLERANCE,
        amountBB: ACTION_VALUE_TOLERANCE,
        frequency: FREQUENCY_TOLERANCE,
        handEV: HAND_EV_TOLERANCE,
      },
      totals: {
        ...totals,
        dimensions: stats.length,
        failedRecords,
      },
      dimensions: stats,
      failures,
      repairSuggestions: getRepairSuggestions(failedRecords, totals.packReadFailures),
    };
  } finally {
    for (const reader of readers.values()) {
      await reader.close();
    }
    metaDb.close();
    sourceDb.close();
  }
}

async function verifyDimension(params: {
  sourceDb: Database;
  metaDb: Database;
  readers: Map<string, RangeBinReader>;
  actionSchemaCache: Map<number, ActionDef[]>;
  binaryDir: string;
  dimension: RangeDimension;
  mode: VerifyMode;
  sampleQuota: number;
  maxFailures: number;
  failures: VerifyFailure[];
}): Promise<DimensionVerifyStats> {
  const stats = createDimensionStats(params.dimension);

  if (params.mode === "sample") {
    const rows = getSampleRows(params.sourceDb, params.dimension.rangeTable, params.sampleQuota);
    const rowsByConcreteLine = groupRowsByConcreteLine(rows);

    for (const [concreteLineId, oldRows] of rowsByConcreteLine) {
      await verifyConcreteLineRows({ ...params, stats, concreteLineId, oldRows, checkExtraBinaryRows: false });
    }

    return stats;
  }

  let currentConcreteLineId: number | null = null;
  let rowsForConcreteLine: OldRangeRow[] = [];
  const rows = params.sourceDb
    .query(`
      SELECT concrete_line_id, hole_cards, action_name, action_size, amount_bb, frequency, hand_ev
      FROM ${quoteIdentifier(params.dimension.rangeTable)}
      ORDER BY concrete_line_id, hole_cards, action_name
    `)
    .iterate() as IterableIterator<OldRangeRow>;

  for (const row of rows) {
    if (currentConcreteLineId === null) {
      currentConcreteLineId = row.concrete_line_id;
    }

    if (row.concrete_line_id !== currentConcreteLineId) {
      await verifyConcreteLineRows({
        ...params,
        stats,
        concreteLineId: currentConcreteLineId,
        oldRows: rowsForConcreteLine,
        checkExtraBinaryRows: true,
      });
      currentConcreteLineId = row.concrete_line_id;
      rowsForConcreteLine = [];
    }

    rowsForConcreteLine.push(row);
  }

  if (currentConcreteLineId !== null) {
    await verifyConcreteLineRows({
      ...params,
      stats,
      concreteLineId: currentConcreteLineId,
      oldRows: rowsForConcreteLine,
      checkExtraBinaryRows: true,
    });
  }

  return stats;
}

async function verifyConcreteLineRows(params: {
  metaDb: Database;
  readers: Map<string, RangeBinReader>;
  actionSchemaCache: Map<number, ActionDef[]>;
  binaryDir: string;
  dimension: RangeDimension;
  concreteLineId: number;
  oldRows: OldRangeRow[];
  checkExtraBinaryRows: boolean;
  stats: DimensionVerifyStats;
  maxFailures: number;
  failures: VerifyFailure[];
}): Promise<void> {
  params.stats.checkedConcreteLines += 1;
  params.stats.checkedOldRecords += params.oldRows.length;

  let context: DecodedPackContext;
  try {
    context = await readDecodedPackContext(params);
  } catch (error) {
    params.stats.packReadFailures += 1;
    params.stats.failedOldRecords += params.oldRows.length;
    pushFailure(params.failures, params.maxFailures, {
      dimension: dimensionKey(params.dimension),
      concreteLineId: params.concreteLineId,
      reason: "PACK_READ_FAILED",
      details: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const expectedBinaryCells = new Set<string>();

  for (const row of params.oldRows) {
    const result = verifyOldRow(row, context);
    params.stats.maxFrequencyError = Math.max(params.stats.maxFrequencyError, result.frequencyError);
    params.stats.maxHandEvError = Math.max(params.stats.maxHandEvError, result.handEvError);

    if (result.binaryCellKey) {
      expectedBinaryCells.add(result.binaryCellKey);
    }

    if (result.ok) {
      params.stats.successOldRecords += 1;
    } else {
      params.stats.failedOldRecords += 1;
      pushFailure(params.failures, params.maxFailures, {
        dimension: dimensionKey(params.dimension),
        concreteLineId: row.concrete_line_id,
        holeCards: row.hole_cards,
        actionName: row.action_name,
        reason: result.reason,
        details: result.details,
      });
    }
  }

  if (params.checkExtraBinaryRows) {
    const extraBinaryRecords = countExtraBinaryRecords(context, expectedBinaryCells);
    params.stats.extraBinaryRecords += extraBinaryRecords;

    if (extraBinaryRecords > 0) {
      pushFailure(params.failures, params.maxFailures, {
        dimension: dimensionKey(params.dimension),
        concreteLineId: params.concreteLineId,
        reason: "EXTRA_BINARY_RECORDS",
        details: `Binary pack has ${formatNumber(extraBinaryRecords)} existing cells that do not exist in old SQLite rows.`,
      });
    }
  }
}

function verifyOldRow(
  row: OldRangeRow,
  context: DecodedPackContext,
): {
  ok: boolean;
  reason: string;
  details: string;
  frequencyError: number;
  handEvError: number;
  binaryCellKey?: string;
} {
  let handId: number;
  try {
    handId = getHandId(row.hole_cards);
  } catch (error) {
    return {
      ok: false,
      reason: "UNKNOWN_HAND",
      details: error instanceof Error ? error.message : String(error),
      frequencyError: 0,
      handEvError: 0,
    };
  }

  const localHandIndex = context.handIndexById.get(handId);
  if (localHandIndex === undefined) {
    return {
      ok: false,
      reason: "HAND_NOT_FOUND_IN_PACK",
      details: `Hand ${row.hole_cards} is present in old SQLite but missing from decoded pack.`,
      frequencyError: 0,
      handEvError: 0,
    };
  }

  const action = findMatchingAction(context.actions, row);
  if (!action) {
    return {
      ok: false,
      reason: "ACTION_NOT_FOUND_IN_SCHEMA",
      details: `Action ${row.action_name}/${row.action_size}/${row.amount_bb} is missing from binary action schema.`,
      frequencyError: 0,
      handEvError: 0,
    };
  }

  const cell = context.decoded.cells[localHandIndex * context.actions.length + action.actionId];
  const binaryCellKey = `${handId}\0${action.actionId}`;
  if (!cell.exists) {
    return {
      ok: false,
      reason: "ACTION_CELL_NOT_SET",
      details: "Action exists in old SQLite but the binary action mask does not mark it as present.",
      frequencyError: 0,
      handEvError: 0,
      binaryCellKey,
    };
  }

  const frequencyError = Math.abs(Number(row.frequency) - cell.frequency);
  const handEvError = getNullableNumberError(row.hand_ev, cell.handEV);

  if (frequencyError > FREQUENCY_TOLERANCE) {
    return {
      ok: false,
      reason: "FREQUENCY_MISMATCH",
      details: `old=${row.frequency}, binary=${cell.frequency}, error=${frequencyError}`,
      frequencyError,
      handEvError,
      binaryCellKey,
    };
  }

  if (handEvError > HAND_EV_TOLERANCE) {
    return {
      ok: false,
      reason: "HAND_EV_MISMATCH",
      details: `old=${row.hand_ev}, binary=${cell.handEV}, error=${handEvError}`,
      frequencyError,
      handEvError,
      binaryCellKey,
    };
  }

  return {
    ok: true,
    reason: "OK",
    details: "",
    frequencyError,
    handEvError,
    binaryCellKey,
  };
}

async function readDecodedPackContext(params: {
  metaDb: Database;
  readers: Map<string, RangeBinReader>;
  actionSchemaCache: Map<number, ActionDef[]>;
  binaryDir: string;
  dimension: RangeDimension;
  concreteLineId: number;
}): Promise<DecodedPackContext> {
  const index = getRangePackIndex(params.metaDb, params.dimension, params.concreteLineId);
  if (!index) {
    throw new Error(`Missing range pack index for concrete_line_id=${params.concreteLineId}`);
  }

  const actions = getActionSchema(params.metaDb, params.actionSchemaCache, index.action_schema_id);
  const binFile = getBinFileName(params.dimension.strategy, params.dimension.playerCount, params.dimension.depthBb);
  const reader = await getReader(params.readers, join(params.binaryDir, binFile));
  const bytes = await reader.read(index.offset, index.byte_length);
  assertCrc32c(bytes, index.checksum);

  const decoded = decodeRangePack({
    bytes,
    handCount: index.hand_count,
    actionCount: actions.length,
  });

  return {
    actions,
    decoded,
    handIndexById: new Map(decoded.handIds.map((handId, handIndex) => [handId, handIndex])),
    existingCellCount: decoded.cells.filter((cell) => cell.exists).length,
  };
}

function getRangePackIndex(db: Database, dimension: RangeDimension, concreteLineId: number): RangePackIndexRow | null {
  const tableName = getRangePackIndexTableName(dimension.strategy, dimension.playerCount, dimension.depthBb);
  return db
    .query(`
      SELECT action_schema_id, hand_count, offset, byte_length, checksum
      FROM ${quoteIdentifier(tableName)}
      WHERE concrete_line_id = ?
    `)
    .get(concreteLineId) as RangePackIndexRow | null;
}

function getActionSchema(db: Database, cache: Map<number, ActionDef[]>, actionSchemaId: number): ActionDef[] {
  const cached = cache.get(actionSchemaId);
  if (cached) return cached;

  const row = db
    .query(`
      SELECT action_count, action_blob
      FROM action_schemas
      WHERE id = ?
    `)
    .get(actionSchemaId) as { action_count: number; action_blob: Uint8Array } | null;

  if (!row) {
    throw new Error(`Missing action schema: ${actionSchemaId}`);
  }

  const actionBlob = new Uint8Array(row.action_blob.buffer, row.action_blob.byteOffset, row.action_blob.byteLength);
  const actions = decodeActionSchema(actionBlob, row.action_count);
  cache.set(actionSchemaId, actions);
  return actions;
}

async function getReader(readers: Map<string, RangeBinReader>, path: string): Promise<RangeBinReader> {
  const cached = readers.get(path);
  if (cached) return cached;

  const reader = new RangeBinReader(path);
  await reader.open();
  readers.set(path, reader);
  return reader;
}

function findMatchingAction(actions: ActionDef[], row: OldRangeRow): ActionDef | null {
  const actionName = normalizeActionName(row.action_name);
  const actionSize = Number(row.action_size);
  const amountBB = Number(row.amount_bb);

  return (
    actions.find(
      (action) =>
        action.actionName === actionName &&
        Math.abs(action.actionSize - actionSize) <= ACTION_VALUE_TOLERANCE &&
        Math.abs(action.amountBB - amountBB) <= ACTION_VALUE_TOLERANCE,
    ) ?? null
  );
}

function countExtraBinaryRecords(context: DecodedPackContext, expectedBinaryCells: Set<string>): number {
  let count = 0;
  for (const cell of context.decoded.cells) {
    if (!cell.exists) continue;
    const key = `${cell.handId}\0${cell.actionId}`;
    if (!expectedBinaryCells.has(key)) count += 1;
  }

  return count;
}

function getSampleRows(db: Database, tableName: string, limit: number): OldRangeRow[] {
  if (limit <= 0) return [];

  return db
    .query(`
      SELECT concrete_line_id, hole_cards, action_name, action_size, amount_bb, frequency, hand_ev
      FROM ${quoteIdentifier(tableName)}
      ORDER BY random()
      LIMIT ?
    `)
    .all(limit) as OldRangeRow[];
}

function getSampleQuotas(db: Database, dimensions: RangeDimension[], sampleSize: number): Map<string, number> {
  const rowCounts = dimensions.map((dimension) => ({
    dimension,
    rowCount: getTableRowCount(db, dimension.rangeTable),
  }));
  const totalRows = rowCounts.reduce((total, item) => total + item.rowCount, 0);
  const quotas = new Map<string, number>();

  if (totalRows === 0 || sampleSize <= 0) {
    for (const { dimension } of rowCounts) {
      quotas.set(dimensionKey(dimension), 0);
    }
    return quotas;
  }

  let assigned = 0;
  for (let index = 0; index < rowCounts.length; index++) {
    const { dimension, rowCount } = rowCounts[index];
    const remainingDimensions = rowCounts.length - index - 1;
    const remainingBudget = sampleSize - assigned;
    const quota =
      remainingDimensions === 0
        ? Math.min(rowCount, Math.max(remainingBudget, 0))
        : Math.min(rowCount, Math.max(1, Math.floor((rowCount / totalRows) * sampleSize)));

    quotas.set(dimensionKey(dimension), quota);
    assigned += quota;
  }

  return quotas;
}

function getTableRowCount(db: Database, tableName: string): number {
  const row = db.query(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`).get() as { count: number };
  return row.count;
}

function groupRowsByConcreteLine(rows: OldRangeRow[]): Map<number, OldRangeRow[]> {
  const result = new Map<number, OldRangeRow[]>();
  for (const row of rows) {
    const existing = result.get(row.concrete_line_id);
    if (existing) {
      existing.push(row);
    } else {
      result.set(row.concrete_line_id, [row]);
    }
  }
  return result;
}

function filterDimensions(discovered: RangeDimension[], requested: RequestedDimension[]): RangeDimension[] {
  if (requested.length === 0) return discovered;

  return discovered.filter((dimension) =>
    requested.some(
      (item) =>
        item.strategy === dimension.strategy &&
        item.playerCount === dimension.playerCount &&
        item.depthBb === dimension.depthBb,
    ),
  );
}

function createDimensionStats(dimension: RangeDimension): DimensionVerifyStats {
  return {
    dimension: dimensionKey(dimension),
    checkedConcreteLines: 0,
    checkedOldRecords: 0,
    successOldRecords: 0,
    failedOldRecords: 0,
    extraBinaryRecords: 0,
    packReadFailures: 0,
    maxFrequencyError: 0,
    maxHandEvError: 0,
  };
}

function mergeStats(stats: DimensionVerifyStats[]): Omit<VerifyReport["totals"], "dimensions" | "failedRecords"> {
  return {
    checkedConcreteLines: sum(stats.map((item) => item.checkedConcreteLines)),
    checkedOldRecords: sum(stats.map((item) => item.checkedOldRecords)),
    successOldRecords: sum(stats.map((item) => item.successOldRecords)),
    failedOldRecords: sum(stats.map((item) => item.failedOldRecords)),
    extraBinaryRecords: sum(stats.map((item) => item.extraBinaryRecords)),
    packReadFailures: sum(stats.map((item) => item.packReadFailures)),
    maxFrequencyError: Math.max(0, ...stats.map((item) => item.maxFrequencyError)),
    maxHandEvError: Math.max(0, ...stats.map((item) => item.maxHandEvError)),
  };
}

function getNullableNumberError(left: number | null, right: number | null): number {
  if (left === null && right === null) return 0;
  if (left === null || right === null) return Number.POSITIVE_INFINITY;
  return Math.abs(Number(left) - Number(right));
}

function pushFailure(failures: VerifyFailure[], maxFailures: number, failure: VerifyFailure): void {
  if (failures.length >= maxFailures) return;
  failures.push(failure);
}

function getRepairSuggestions(failedRecords: number, packReadFailures: number): string[] {
  if (failedRecords === 0 && packReadFailures === 0) {
    return ["校验通过。可以继续运行 full 模式或进入 benchmark 阶段。"];
  }

  const suggestions = [
    "确认二进制目录由当前 source SQLite 重新构建，避免 meta.db 与 ranges_*.bin 来自不同版本。",
    "使用 --verify-checksum 或本命令重新扫描，优先排查 ranges_*.bin 是否损坏。",
    "如出现大量 ACTION_NOT_FOUND_IN_SCHEMA，检查 action_name 规范化和 action_size / amount_bb 的 Float32 精度策略。",
  ];

  if (packReadFailures > 0) {
    suggestions.unshift("优先检查 meta.db 中的 range_pack_index offset/byte_length/checksum 与 ranges_*.bin 文件是否匹配。");
  }

  return suggestions;
}

async function writeJson(path: string, report: VerifyReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(report, null, 2)}\n`);
}

async function writeMarkdown(path: string, report: VerifyReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, renderMarkdown(report));
}

function renderMarkdown(report: VerifyReport): string {
  const dimensionRows = report.dimensions.map((dimension) => [
    dimension.dimension,
    formatNumber(dimension.checkedConcreteLines),
    formatNumber(dimension.checkedOldRecords),
    formatNumber(dimension.successOldRecords),
    formatNumber(dimension.failedOldRecords),
    formatNumber(dimension.extraBinaryRecords),
    formatNumber(dimension.packReadFailures),
  ]);

  const failureRows = report.failures.map((failure) => [
    failure.dimension,
    failure.concreteLineId,
    failure.holeCards ?? "",
    failure.actionName ?? "",
    failure.reason,
    failure.details,
  ]);

  const failureSection =
    failureRows.length === 0
      ? "未发现失败样例。"
      : markdownTable(["dimension", "line", "hand", "action", "reason", "details"], failureRows);

  return `# 二进制一致性校验报告

生成时间：${report.generatedAt}

## 总览

- 源 SQLite：\`${report.sourceDbPath}\`
- 二进制目录：\`${report.binaryDir}\`
- meta.db：\`${report.metaDbPath}\`
- 模式：${report.mode}
- sample size：${report.sampleSize === undefined ? "N/A" : formatNumber(report.sampleSize)}
- 维度数量：${formatNumber(report.totals.dimensions)}
- 校验 concrete line：${formatNumber(report.totals.checkedConcreteLines)}
- 校验旧记录数：${formatNumber(report.totals.checkedOldRecords)}
- 成功旧记录数：${formatNumber(report.totals.successOldRecords)}
- 失败旧记录数：${formatNumber(report.totals.failedOldRecords)}
- 二进制额外记录数：${formatNumber(report.totals.extraBinaryRecords)}
- 失败记录总数：${formatNumber(report.totals.failedRecords)}
- pack 读取失败数：${formatNumber(report.totals.packReadFailures)}
- frequency 最大误差：${report.totals.maxFrequencyError}
- hand_ev 最大误差：${report.totals.maxHandEvError}

## 误差阈值

- action_size：${report.tolerances.actionSize}
- amount_bb：${report.tolerances.amountBB}
- frequency：${report.tolerances.frequency}
- hand_ev：${report.tolerances.handEV}

## 维度结果

${markdownTable(
  ["dimension", "lines", "checked old rows", "success", "failed old rows", "extra binary rows", "pack failures"],
  dimensionRows,
)}

## 失败样例

${failureSection}

## 修复建议

${report.repairSuggestions.map((suggestion) => `- ${suggestion}`).join("\n")}
`;
}

function parseMode(value: string): VerifyMode {
  if (value === "sample" || value === "full") return value;
  throw new Error(`Invalid --mode value: ${value}. Use sample or full.`);
}

function parseDimension(value: string): RequestedDimension {
  const tableLike = value.match(/^(.+)_([0-9]+)max_([0-9]+)BB$/);
  if (tableLike) {
    return {
      strategy: tableLike[1],
      playerCount: Number(tableLike[2]),
      depthBb: Number(tableLike[3]),
    };
  }

  const colonLike = value.match(/^(.+):([0-9]+)(?:max)?:([0-9]+)(?:BB)?$/);
  if (colonLike) {
    return {
      strategy: colonLike[1],
      playerCount: Number(colonLike[2]),
      depthBb: Number(colonLike[3]),
    };
  }

  throw new Error(`Invalid --dimension value: ${value}. Use default:6:100 or default_6max_100BB.`);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
