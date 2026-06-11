import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  compareActionDefs,
  encodeActionSchema,
  normalizeActionName,
  type ActionDef,
} from "../binary/action-schema-codec";
import { crc32c } from "../binary/crc32c";
import { RangeBinWriter } from "../binary/range-bin-writer";
import { encodeRangePack, setMaskBit, type RangeCellValue } from "../binary/range-pack-codec";
import { quoteIdentifier, type RangeDimension } from "../db/naming";
import { initBinaryMetaDb } from "../db/schema";
import { getHandId } from "../hand/hand-dict";
import { discoverRangeDimensions, type OldRangeRow } from "./old-sqlite";

export interface BuildBinaryStoreOptions {
  sourceDbPath: string;
  outDir: string;
  overwrite?: boolean;
  dimensions?: Array<Pick<RangeDimension, "strategy" | "playerCount" | "depthBb">>;
  maxConcreteLinesPerDimension?: number;
  progressEveryPacks?: number;
}

interface EncodedConcreteLinePack {
  actionBlob: Uint8Array;
  actionCount: number;
  handCount: number;
  payload: Uint8Array;
}

interface BuildStatements {
  insertDrillLine: ReturnType<Database["prepare"]>;
  insertConcreteLine: ReturnType<Database["prepare"]>;
  selectActionSchema: ReturnType<Database["prepare"]>;
  insertActionSchema: ReturnType<Database["prepare"]>;
  lastInsertId: ReturnType<Database["prepare"]>;
  insertRangePackIndex: ReturnType<Database["prepare"]>;
}

export async function buildBinaryStore(options: BuildBinaryStoreOptions): Promise<void> {
  await mkdir(options.outDir, { recursive: true });

  const metaPath = join(options.outDir, "meta.db");
  if (existsSync(metaPath)) {
    if (!options.overwrite) {
      throw new Error(`Output meta DB already exists: ${metaPath}. Pass --overwrite to rebuild it.`);
    }

    await rm(metaPath, { force: true });
    await rm(`${metaPath}-wal`, { force: true });
    await rm(`${metaPath}-shm`, { force: true });
  }

  const sourceDb = new Database(options.sourceDbPath, { readonly: true });
  const metaDb = new Database(metaPath);

  try {
    initBinaryMetaDb(metaDb);
    const dimensions = filterDimensions(discoverRangeDimensions(sourceDb), options.dimensions);
    const statements = prepareBuildStatements(metaDb);
    const schemaIdByKey = new Map<string, number>();

    metaDb.exec("BEGIN");
    try {
      copyDrillScenarioLines({ sourceDb, metaDb, statements, strategies: uniqueStrategies(dimensions) });
      for (const dimension of dimensions) {
        copyConcreteLines({ sourceDb, statements, dimension });
      }
      metaDb.exec("COMMIT");
    } catch (error) {
      metaDb.exec("ROLLBACK");
      throw error;
    }

    for (const dimension of dimensions) {
      await buildDimension({
        sourceDb,
        metaDb,
        statements,
        schemaIdByKey,
        dimension,
        outDir: options.outDir,
        overwrite: options.overwrite,
        maxConcreteLines: options.maxConcreteLinesPerDimension,
        progressEveryPacks: options.progressEveryPacks ?? 10000,
      });
    }

    metaDb
      .prepare("INSERT OR REPLACE INTO build_info(key, value) VALUES (?, ?)")
      .run("built_at", new Date().toISOString());
    metaDb.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");
  } finally {
    metaDb.close();
    sourceDb.close();
  }
}

function filterDimensions(
  discovered: RangeDimension[],
  requested: BuildBinaryStoreOptions["dimensions"],
): RangeDimension[] {
  if (!requested || requested.length === 0) return discovered;

  return discovered.filter((dimension) =>
    requested.some(
      (item) =>
        item.strategy === dimension.strategy &&
        item.playerCount === dimension.playerCount &&
        item.depthBb === dimension.depthBb,
    ),
  );
}

function uniqueStrategies(dimensions: RangeDimension[]): string[] {
  return [...new Set(dimensions.map((dimension) => dimension.strategy))];
}

function prepareBuildStatements(metaDb: Database): BuildStatements {
  return {
    insertDrillLine: metaDb.prepare(`
      INSERT OR IGNORE INTO drill_scenario_lines(strategy, drill_name, abstract_line, player_count, drill_depth)
      VALUES (?, ?, ?, ?, ?)
    `),
    insertConcreteLine: metaDb.prepare(`
      INSERT OR IGNORE INTO concrete_lines(strategy, player_count, depth_bb, concrete_line_id, abstract_line, concrete_line)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    selectActionSchema: metaDb.prepare("SELECT id FROM action_schemas WHERE schema_key = ?"),
    insertActionSchema: metaDb.prepare(`
      INSERT INTO action_schemas(action_count, action_blob, checksum, schema_key)
      VALUES (?, ?, ?, ?)
    `),
    lastInsertId: metaDb.prepare("SELECT last_insert_rowid() AS id"),
    insertRangePackIndex: metaDb.prepare(`
      INSERT OR REPLACE INTO range_pack_index(
        strategy, player_count, depth_bb, concrete_line_id, action_schema_id,
        hand_count, offset, byte_length, checksum, bin_file
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
  };
}

function copyDrillScenarioLines(params: {
  sourceDb: Database;
  metaDb: Database;
  statements: BuildStatements;
  strategies: string[];
}): void {
  for (const strategy of params.strategies) {
    const table = `drill_scenario_lines_${strategy}`;
    const exists = params.sourceDb
      .query("SELECT 1 AS ok FROM sqlite_master WHERE type = ? AND name = ?")
      .get("table", table);
    if (!exists) continue;

    const rows = params.sourceDb
      .query(`
        SELECT drill_name, abstract_line, player_count, depth
        FROM ${quoteIdentifier(table)}
        ORDER BY id
      `)
      .iterate() as IterableIterator<{
      drill_name: string;
      abstract_line: string;
      player_count: number;
      depth: number;
    }>;

    for (const row of rows) {
      params.statements.insertDrillLine.run(
        strategy,
        row.drill_name,
        row.abstract_line,
        row.player_count,
        row.depth,
      );
    }
  }
}

function copyConcreteLines(params: {
  sourceDb: Database;
  statements: BuildStatements;
  dimension: RangeDimension;
}): void {
  const rows = params.sourceDb
    .query(`
      SELECT id, abstract_line, concrete_line
      FROM ${quoteIdentifier(params.dimension.concreteTable)}
      ORDER BY id
    `)
    .iterate() as IterableIterator<{ id: number; abstract_line: string; concrete_line: string }>;

  for (const row of rows) {
    params.statements.insertConcreteLine.run(
      params.dimension.strategy,
      params.dimension.playerCount,
      params.dimension.depthBb,
      row.id,
      row.abstract_line,
      row.concrete_line,
    );
  }
}

async function buildDimension(params: {
  sourceDb: Database;
  metaDb: Database;
  statements: BuildStatements;
  schemaIdByKey: Map<string, number>;
  dimension: RangeDimension;
  outDir: string;
  overwrite?: boolean;
  maxConcreteLines?: number;
  progressEveryPacks: number;
}): Promise<void> {
  const binPath = join(params.outDir, params.dimension.binFile);
  const writer = await RangeBinWriter.create(binPath, { overwrite: params.overwrite });
  let currentConcreteLineId: number | null = null;
  let rowsForConcreteLine: OldRangeRow[] = [];
  let processedPacks = 0;

  const flushCurrent = async (): Promise<boolean> => {
    if (currentConcreteLineId === null) return true;

    const concreteLineId = currentConcreteLineId;
    const encoded = encodeConcreteLinePack(rowsForConcreteLine);
    const actionSchemaId = getOrInsertActionSchema({
      statements: params.statements,
      schemaIdByKey: params.schemaIdByKey,
      actionBlob: encoded.actionBlob,
      actionCount: encoded.actionCount,
    });
    const appended = await writer.append(encoded.payload);

    params.statements.insertRangePackIndex.run(
      params.dimension.strategy,
      params.dimension.playerCount,
      params.dimension.depthBb,
      concreteLineId,
      actionSchemaId,
      encoded.handCount,
      appended.offset,
      appended.byteLength,
      appended.checksum,
      params.dimension.binFile,
    );

    processedPacks += 1;
    if (processedPacks % params.progressEveryPacks === 0) {
      console.log(
        `[${params.dimension.strategy} ${params.dimension.playerCount}max ${params.dimension.depthBb}BB] packs=${processedPacks}`,
      );
    }

    currentConcreteLineId = null;
    rowsForConcreteLine = [];

    return !params.maxConcreteLines || processedPacks < params.maxConcreteLines;
  };

  params.metaDb.exec("BEGIN");
  try {
    const rangeRows = params.sourceDb
      .query(`
        SELECT concrete_line_id, hole_cards, action_name, action_size, amount_bb, frequency, hand_ev
        FROM ${quoteIdentifier(params.dimension.rangeTable)}
        ORDER BY concrete_line_id, hole_cards, action_name
      `)
      .iterate() as IterableIterator<OldRangeRow>;

    for (const row of rangeRows) {
      if (currentConcreteLineId === null) {
        currentConcreteLineId = row.concrete_line_id;
      }

      if (row.concrete_line_id !== currentConcreteLineId) {
        const shouldContinue = await flushCurrent();
        if (!shouldContinue) break;

        currentConcreteLineId = row.concrete_line_id;
        rowsForConcreteLine = [];
      }

      rowsForConcreteLine.push(row);
    }

    await flushCurrent();
    params.metaDb.exec("COMMIT");
  } catch (error) {
    params.metaDb.exec("ROLLBACK");
    throw error;
  } finally {
    await writer.close();
  }
}

function getOrInsertActionSchema(params: {
  statements: BuildStatements;
  schemaIdByKey: Map<string, number>;
  actionBlob: Uint8Array;
  actionCount: number;
}): number {
  const schemaKey = toHex(params.actionBlob);
  const cachedId = params.schemaIdByKey.get(schemaKey);
  if (cachedId !== undefined) return cachedId;

  const existing = params.statements.selectActionSchema.get(schemaKey) as { id: number } | null;
  if (existing) {
    params.schemaIdByKey.set(schemaKey, existing.id);
    return existing.id;
  }

  params.statements.insertActionSchema.run(
    params.actionCount,
    Buffer.from(params.actionBlob.buffer, params.actionBlob.byteOffset, params.actionBlob.byteLength),
    crc32c(params.actionBlob),
    schemaKey,
  );
  const inserted = params.statements.lastInsertId.get() as { id: number };
  params.schemaIdByKey.set(schemaKey, inserted.id);
  return inserted.id;
}

export function encodeConcreteLinePack(rows: OldRangeRow[]): EncodedConcreteLinePack {
  if (rows.length === 0) throw new Error("Cannot encode empty concrete line range pack");

  const actionByKey = new Map<string, Pick<ActionDef, "actionName" | "actionSize" | "amountBB">>();
  const handIds = [...new Set(rows.map((row) => getHandId(row.hole_cards)))].sort((left, right) => left - right);

  for (const row of rows) {
    const actionName = normalizeActionName(row.action_name);
    const actionSize = Number(row.action_size);
    const amountBB = Number(row.amount_bb);
    actionByKey.set(actionKey(actionName, actionSize, amountBB), { actionName, actionSize, amountBB });
  }

  const actions = [...actionByKey.values()].sort(compareActionDefs).map((action, actionId) => ({
    actionId,
    ...action,
  }));
  if (actions.length > 32) {
    throw new Error(`V1 range pack supports up to 32 actions, got ${actions.length}`);
  }

  const actionIdByKey = new Map(actions.map((action) => [actionKey(action.actionName, action.actionSize, action.amountBB), action.actionId]));
  const handIndexById = new Map(handIds.map((handId, handIndex) => [handId, handIndex]));
  const actionMasks = new Array<number>(handIds.length).fill(0);
  const values: RangeCellValue[][] = handIds.map(() =>
    actions.map(() => ({
      frequency: 0,
      handEV: null,
    })),
  );

  for (const row of rows) {
    const handId = getHandId(row.hole_cards);
    const handIndex = handIndexById.get(handId);
    if (handIndex === undefined) throw new Error(`Internal hand index mismatch for ${row.hole_cards}`);

    const normalizedActionName = normalizeActionName(row.action_name);
    const actionId = actionIdByKey.get(actionKey(normalizedActionName, Number(row.action_size), Number(row.amount_bb)));
    if (actionId === undefined) throw new Error(`Internal action index mismatch for ${row.action_name}`);

    actionMasks[handIndex] = setMaskBit(actionMasks[handIndex], actionId);
    values[handIndex][actionId] = {
      frequency: Number(row.frequency),
      handEV: row.hand_ev === null || row.hand_ev === undefined ? null : Number(row.hand_ev),
    };
  }

  const actionBlob = encodeActionSchema(actions);
  const payload = encodeRangePack({
    handIds,
    actionMasks,
    values,
    actionCount: actions.length,
  });

  return {
    actionBlob,
    actionCount: actions.length,
    handCount: handIds.length,
    payload,
  };
}

function actionKey(actionName: string, actionSize: number, amountBB: number): string {
  return `${actionName}\0${actionSize}\0${amountBB}`;
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex");
}
