import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { formatBytes, formatNumber, markdownTable, safeRatio } from "../analysis/format";
import { dimensionKey, quoteIdentifier, type RangeDimension } from "../db/naming";
import { discoverRangeDimensions } from "../importer/old-sqlite";

export interface RequestedDimension {
  strategy: string;
  playerCount: number;
  depthBb: number;
}

export interface HandBenchmarkItem {
  strategy: string;
  playerCount: number;
  depthBb: number;
  concreteLineId: number;
  holeCards: string;
}

export interface BatchBenchmarkItem {
  strategy: string;
  playerCount: number;
  depthBb: number;
  requests: Array<{
    concreteLineId: number;
    holeCards: string;
  }>;
}

export interface BenchmarkWorkload {
  seed: number;
  dimensions: string[];
  handQueries: HandBenchmarkItem[];
  batchQueries: BatchBenchmarkItem[];
  batchSize: number;
}

export interface WorkloadOptions {
  sourceDbPath: string;
  requestedDimensions: RequestedDimension[];
  seed: number;
  handIterations: number;
  batchIterations: number;
  batchSize: number;
}

export interface MemorySnapshot {
  rssBytes: number;
  heapTotalBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
}

export interface ColdStartResult {
  operation: string;
  totalMs: number;
  resultCount: number;
  memoryBefore: MemorySnapshot;
  memoryAfter: MemorySnapshot;
}

export interface BenchmarkCaseResult {
  name: string;
  description: string;
  iterations: number;
  warmupIterations: number;
  totalMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  qps: number;
  resultCount: number;
  errorCount: number;
  firstError: string | null;
}

export interface BenchmarkRunReport {
  generatedAt: string;
  engine: "sqlite" | "binary";
  sourceDbPath: string;
  binaryDir?: string;
  metaDbPath?: string;
  options: {
    seed: number;
    requestedDimensions: string[];
    handIterations: number;
    batchIterations: number;
    batchSize: number;
    warmupIterations: number;
    verifyChecksums?: boolean;
    packCacheSize?: number;
  };
  workload: {
    dimensions: string[];
    handQueries: number;
    batchQueries: number;
    batchSize: number;
  };
  coldStart: ColdStartResult | null;
  cases: BenchmarkCaseResult[];
  totals: {
    iterations: number;
    totalMs: number;
    avgQps: number;
    errorCount: number;
    resultCount: number;
  };
  memory: {
    before: MemorySnapshot;
    after: MemorySnapshot;
    deltaRssBytes: number;
    deltaHeapUsedBytes: number;
  };
  notes: string[];
}

interface SamplingStats {
  dimension: RangeDimension;
  rowCount: number;
  minId: number;
  maxId: number;
}

interface QueryLike {
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
}

interface SampledRangeRow {
  concrete_line_id: number;
  hole_cards: string;
}

export function createBenchmarkWorkload(options: WorkloadOptions): BenchmarkWorkload {
  const db = new Database(options.sourceDbPath, { readonly: true });

  try {
    const dimensions = filterDimensions(discoverRangeDimensions(db), options.requestedDimensions);
    if (dimensions.length === 0) {
      throw new Error("No range dimensions matched the requested benchmark filters.");
    }

    const stats = dimensions.map((dimension) => getSamplingStats(db, dimension)).filter((item) => item.rowCount > 0);
    if (stats.length === 0) {
      throw new Error("No range rows were available for benchmark sampling.");
    }

    const random = createSeededRandom(options.seed);
    const sampler = new WorkloadSampler(db, stats, random);

    return {
      seed: options.seed,
      dimensions: stats.map((item) => dimensionKey(item.dimension)),
      handQueries: sampler.sampleHandQueries(options.handIterations),
      batchQueries: sampler.sampleBatchQueries(options.batchIterations, options.batchSize),
      batchSize: options.batchSize,
    };
  } finally {
    db.close();
  }
}

export async function measureBenchmarkCase<T>(params: {
  name: string;
  description: string;
  items: T[];
  warmupIterations: number;
  operation: (item: T, iteration: number) => number | Promise<number>;
}): Promise<BenchmarkCaseResult> {
  const warmupIterations = params.items.length === 0 ? 0 : Math.min(params.warmupIterations, params.items.length);

  for (let index = 0; index < warmupIterations; index++) {
    const result = params.operation(params.items[index], index);
    if (isPromise(result)) await result;
  }

  let resultCount = 0;
  let errorCount = 0;
  let firstError: string | null = null;

  // 批量计时：整个循环只打两次 performance.now()，避免 per-iteration 开销污染数据
  const caseStart = performance.now();
  for (let index = 0; index < params.items.length; index++) {
    try {
      const result = params.operation(params.items[index], index);
      resultCount += isPromise(result) ? await result : result;
    } catch (error) {
      errorCount += 1;
      firstError ??= error instanceof Error ? error.message : String(error);
    }
  }
  const totalMs = performance.now() - caseStart;

  // avgMs 和 QPS 基于批量计时
  const avgMs = params.items.length > 0 ? totalMs / params.items.length : 0;

  return {
    name: params.name,
    description: params.description,
    iterations: params.items.length,
    warmupIterations,
    totalMs,
    avgMs,
    p50Ms: 0,
    p95Ms: 0,
    p99Ms: 0,
    maxMs: 0,
    qps: safeRatio(params.items.length, totalMs / 1000),
    resultCount,
    errorCount,
    firstError,
  };
}

export function buildTotals(cases: BenchmarkCaseResult[]): BenchmarkRunReport["totals"] {
  const iterations = sum(cases.map((item) => item.iterations));
  const totalMs = sum(cases.map((item) => item.totalMs));

  return {
    iterations,
    totalMs,
    avgQps: safeRatio(iterations, totalMs / 1000),
    errorCount: sum(cases.map((item) => item.errorCount)),
    resultCount: sum(cases.map((item) => item.resultCount)),
  };
}

export function getMemorySnapshot(): MemorySnapshot {
  const usage = process.memoryUsage();
  return {
    rssBytes: usage.rss,
    heapTotalBytes: usage.heapTotal,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers ?? 0,
  };
}

export async function writeBenchmarkJson(path: string, report: BenchmarkRunReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(report, null, 2)}\n`);
}

export async function writeBenchmarkMarkdown(path: string, report: BenchmarkRunReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, renderBenchmarkMarkdown(report));
}

export async function readBenchmarkReport(path: string): Promise<BenchmarkRunReport> {
  return JSON.parse(await Bun.file(path).text()) as BenchmarkRunReport;
}

export function renderBenchmarkMarkdown(report: BenchmarkRunReport): string {
  const caseRows = report.cases.map((item) => [
    item.name,
    formatNumber(item.iterations),
    formatMs(item.avgMs),
    item.p50Ms > 0 ? formatMs(item.p50Ms) : "N/A",
    item.p95Ms > 0 ? formatMs(item.p95Ms) : "N/A",
    item.p99Ms > 0 ? formatMs(item.p99Ms) : "N/A",
    item.maxMs > 0 ? formatMs(item.maxMs) : "N/A",
    item.qps.toFixed(2),
    formatNumber(item.errorCount),
  ]);

  const coldStart = report.coldStart
    ? `- 冷启动首查：${formatMs(report.coldStart.totalMs)}，返回 action 数：${formatNumber(report.coldStart.resultCount)}`
    : "- 冷启动首查：未执行";

  return `# ${report.engine === "sqlite" ? "SQLite" : "二进制"} Benchmark 报告

生成时间：${report.generatedAt}

## 总览

- 引擎：${report.engine}
- 源 SQLite：\`${report.sourceDbPath}\`
${report.binaryDir ? `- 二进制目录：\`${report.binaryDir}\`\n` : ""}${report.metaDbPath ? `- meta.db：\`${report.metaDbPath}\`\n` : ""}- 维度：${report.workload.dimensions.join(", ")}
- workload seed：${report.options.seed}
- 总迭代：${formatNumber(report.totals.iterations)}
- 总耗时：${formatMs(report.totals.totalMs)}
- 综合 QPS：${report.totals.avgQps.toFixed(2)}
- 错误数：${formatNumber(report.totals.errorCount)}
- 返回 action 总数：${formatNumber(report.totals.resultCount)}
- RSS 变化：${formatBytes(report.memory.deltaRssBytes)}
- heap used 变化：${formatBytes(report.memory.deltaHeapUsedBytes)}
${coldStart}

## Workload

- 单手牌查询：${formatNumber(report.workload.handQueries)}
- 批量查询：${formatNumber(report.workload.batchQueries)}
- batch size：${formatNumber(report.workload.batchSize)}
- warmup iterations：${formatNumber(report.options.warmupIterations)}

## 延迟结果

${markdownTable(["case", "iters", "avg", "p50", "p95", "p99", "max", "qps", "errors"], caseRows)}

## 内存

- before RSS：${formatBytes(report.memory.before.rssBytes)}
- after RSS：${formatBytes(report.memory.after.rssBytes)}
- before heap used：${formatBytes(report.memory.before.heapUsedBytes)}
- after heap used：${formatBytes(report.memory.after.heapUsedBytes)}

## 说明

${report.notes.map((note) => `- ${note}`).join("\n")}
`;
}

export function parseRequestedDimension(value: string): RequestedDimension {
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

export function formatMs(value: number): string {
  if (!Number.isFinite(value)) return "unknown";
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${value.toFixed(value >= 10 ? 2 : 3)} ms`;
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

function getSamplingStats(db: Database, dimension: RangeDimension): SamplingStats {
  const row = db
    .query(`
      SELECT MIN(id) AS minId, MAX(id) AS maxId, COUNT(*) AS rowCount
      FROM ${quoteIdentifier(dimension.rangeTable)}
    `)
    .get() as { minId: number | null; maxId: number | null; rowCount: number };

  return {
    dimension,
    rowCount: row.rowCount,
    minId: row.minId ?? 0,
    maxId: row.maxId ?? 0,
  };
}

class WorkloadSampler {
  private readonly totalRows: number;
  private readonly sampleStatements = new Map<string, { nextById: QueryLike; first: QueryLike }>();

  constructor(
    private readonly db: Database,
    private readonly stats: SamplingStats[],
    private readonly random: SeededRandom,
  ) {
    this.totalRows = sum(stats.map((item) => item.rowCount));
  }

  sampleHandQueries(count: number): HandBenchmarkItem[] {
    const result: HandBenchmarkItem[] = [];
    const seen = new Set<string>();
    const maxAttempts = Math.max(count * 20, count + 100);

    for (let attempts = 0; result.length < count && attempts < maxAttempts; attempts++) {
      const item = this.sampleHandQuery();
      const key = `${dimensionKey(item)}:${item.concreteLineId}:${item.holeCards}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(item);
    }

    while (result.length < count) {
      result.push(this.sampleHandQuery());
    }

    return result;
  }

  sampleBatchQueries(count: number, batchSize: number): BatchBenchmarkItem[] {
    const result: BatchBenchmarkItem[] = [];
    const safeBatchSize = Math.max(1, batchSize);

    for (let index = 0; index < count; index++) {
      const stats = this.pickStats();
      const requests: BatchBenchmarkItem["requests"] = [];
      for (let requestIndex = 0; requestIndex < safeBatchSize; requestIndex++) {
        const item = this.sampleHandQuery(stats);
        requests.push({
          concreteLineId: item.concreteLineId,
          holeCards: item.holeCards,
        });
      }

      result.push({
        strategy: stats.dimension.strategy,
        playerCount: stats.dimension.playerCount,
        depthBb: stats.dimension.depthBb,
        requests,
      });
    }

    return result;
  }

  private sampleHandQuery(forcedStats?: SamplingStats): HandBenchmarkItem {
    const stats = forcedStats ?? this.pickStats();
    const row = this.sampleRangeRow(stats);

    return {
      strategy: stats.dimension.strategy,
      playerCount: stats.dimension.playerCount,
      depthBb: stats.dimension.depthBb,
      concreteLineId: row.concrete_line_id,
      holeCards: row.hole_cards,
    };
  }

  private pickStats(): SamplingStats {
    let target = this.random.next() * this.totalRows;
    for (const item of this.stats) {
      target -= item.rowCount;
      if (target <= 0) return item;
    }

    return this.stats[this.stats.length - 1];
  }

  private sampleRangeRow(stats: SamplingStats): SampledRangeRow {
    const statements = this.getSampleStatements(stats.dimension.rangeTable);
    const randomId = stats.minId + this.random.nextInt(Math.max(1, stats.maxId - stats.minId + 1));
    const row = statements.nextById.get(randomId) ?? statements.first.get();
    if (!row) {
      throw new Error(`Could not sample row from ${stats.dimension.rangeTable}`);
    }

    return row as SampledRangeRow;
  }

  private getSampleStatements(rangeTable: string): { nextById: QueryLike; first: QueryLike } {
    const cached = this.sampleStatements.get(rangeTable);
    if (cached) return cached;

    const statements = {
      nextById: this.db.query(`
        SELECT concrete_line_id, hole_cards
        FROM ${quoteIdentifier(rangeTable)}
        WHERE id >= ?
        ORDER BY id
        LIMIT 1
      `) as QueryLike,
      first: this.db.query(`
        SELECT concrete_line_id, hole_cards
        FROM ${quoteIdentifier(rangeTable)}
        ORDER BY id
        LIMIT 1
      `) as QueryLike,
    };
    this.sampleStatements.set(rangeTable, statements);
    return statements;
  }

}

interface SeededRandom {
  next: () => number;
  nextInt: (maxExclusive: number) => number;
  pick: <T>(items: T[]) => T;
}

function createSeededRandom(seed: number): SeededRandom {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    nextInt: (maxExclusive: number) => Math.floor(next() * Math.max(1, maxExclusive)),
    pick: <T>(items: T[]): T => {
      if (items.length === 0) throw new Error("Cannot pick from an empty array.");
      return items[Math.floor(next() * items.length)];
    },
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function isPromise(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && typeof (value as Promise<unknown>).then === "function";
}
