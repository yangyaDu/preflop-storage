import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  getConcreteLinesTableName,
  quoteIdentifier,
} from "../../src/db/naming";
import { buildRangeStrataBinaryStore } from "../../src/range-strata-binary/compiler/pipeline";
import type { BuildRangeStrataBinaryStoreOptions } from "../../src/range-strata-binary/compiler/types";
import type { TempDirRegistry } from "./temp-dir";

export interface ConcreteLineFixtureRow {
  id: number;
  abstractLine: string;
  concreteLine: string;
}

export interface RangeDataFixtureRow {
  concreteLineId: number;
  holeCards: string;
  actionName: string;
  actionSize: number;
  amountBb: number;
  frequency: number;
  handEv: number | null;
}

export interface RangeDimensionFixture {
  strategy?: string;
  playerCount: number;
  depthBb: number;
  concreteLines: ConcreteLineFixtureRow[];
  rangeRows: RangeDataFixtureRow[];
}

export interface DrillScenarioFixtureRow {
  strategy?: string;
  drillName: string;
  abstractLine: string;
  playerCount: number;
  drillDepth?: number;
}

export interface RangeDbFixtureSpec {
  dimensions: RangeDimensionFixture[];
  drillScenarioLines?: DrillScenarioFixtureRow[];
}

export type BuildFixtureOptions = Omit<BuildRangeStrataBinaryStoreOptions, "sourceDbPath" | "outDir">;

export interface RangeDbFixturePaths {
  rootDir: string;
  sourcePath: string;
  outDir: string;
}

export async function createBuiltRangeDbFixture(params: {
  tempDirs: TempDirRegistry;
  prefix: string;
  spec: RangeDbFixtureSpec;
  buildOptions?: BuildFixtureOptions;
}): Promise<RangeDbFixturePaths> {
  const rootDir = await params.tempDirs.make(params.prefix);
  return createBuiltRangeDbFixtureInRoot(rootDir, params.spec, params.buildOptions);
}

export async function createBuiltRangeDbFixtureInRoot(
  rootDir: string,
  spec: RangeDbFixtureSpec,
  buildOptions: BuildFixtureOptions = {},
): Promise<RangeDbFixturePaths> {
  const paths = await createRangeDbFixtureInRoot(rootDir, spec);
  await buildRangeStrataBinaryStore({
    sourceDbPath: paths.sourcePath,
    outDir: paths.outDir,
    overwrite: true,
    ...buildOptions,
  });
  return paths;
}

export async function createRangeDbFixtureInRoot(
  rootDir: string,
  spec: RangeDbFixtureSpec,
): Promise<RangeDbFixturePaths> {
  await mkdir(rootDir, { recursive: true });
  const sourcePath = join(rootDir, "range.db");
  const outDir = join(rootDir, "range-strata-binary");
  const db = new Database(sourcePath);

  try {
    for (const dimension of spec.dimensions) {
      createDimensionTables(db, dimension);
    }

    const drillScenarioLines = spec.drillScenarioLines ?? defaultDrillScenarioLines(spec.dimensions);
    createDrillScenarioTables(db, drillScenarioLines);
    insertDrillScenarioLines(db, drillScenarioLines);

    for (const dimension of spec.dimensions) {
      insertDimensionRows(db, dimension);
    }
  } finally {
    db.close();
  }

  return { rootDir, sourcePath, outDir };
}

function createDimensionTables(db: Database, dimension: RangeDimensionFixture): void {
  const strategy = dimension.strategy ?? "default";
  const concreteTable = quoteIdentifier(getConcreteLinesTableName(strategy, dimension.playerCount, dimension.depthBb));
  const rangeTable = quoteIdentifier(getRangeDataTableName(strategy, dimension.playerCount, dimension.depthBb));

  db.exec(`
    CREATE TABLE ${concreteTable} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      abstract_line TEXT NOT NULL,
      concrete_line TEXT NOT NULL,
      UNIQUE(abstract_line, concrete_line)
    );

    CREATE TABLE ${rangeTable} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      concrete_line_id INTEGER NOT NULL,
      hole_cards TEXT NOT NULL,
      action_name TEXT NOT NULL,
      action_size REAL NOT NULL,
      amount_bb REAL NOT NULL,
      frequency REAL NOT NULL,
      hand_ev REAL
    );
  `);
}

function createDrillScenarioTables(db: Database, rows: DrillScenarioFixtureRow[]): void {
  const strategies = new Set(rows.map((row) => row.strategy ?? "default"));
  for (const strategy of strategies) {
    db.exec(`
      CREATE TABLE ${quoteIdentifier(`drill_scenario_lines_${strategy}`)} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        drill_name TEXT NOT NULL,
        abstract_line TEXT NOT NULL,
        player_count INTEGER NOT NULL,
        depth INTEGER NOT NULL
      );
    `);
  }
}

function insertDimensionRows(db: Database, dimension: RangeDimensionFixture): void {
  const strategy = dimension.strategy ?? "default";
  const concreteTable = quoteIdentifier(getConcreteLinesTableName(strategy, dimension.playerCount, dimension.depthBb));
  const rangeTable = quoteIdentifier(getRangeDataTableName(strategy, dimension.playerCount, dimension.depthBb));
  const insertConcrete = db.query(`
    INSERT INTO ${concreteTable}(id, abstract_line, concrete_line)
    VALUES (?, ?, ?)
  `);
  const insertRangeData = db.query(`
    INSERT INTO ${rangeTable}(
      concrete_line_id, hole_cards, action_name, action_size, amount_bb, frequency, hand_ev
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const row of dimension.concreteLines) {
    insertConcrete.run(row.id, row.abstractLine, row.concreteLine);
  }

  for (const row of dimension.rangeRows) {
    insertRangeData.run(
      row.concreteLineId,
      row.holeCards,
      row.actionName,
      row.actionSize,
      row.amountBb,
      row.frequency,
      row.handEv,
    );
  }
}

function insertDrillScenarioLines(db: Database, rows: DrillScenarioFixtureRow[]): void {
  const statements = new Map<string, ReturnType<Database["query"]>>();
  try {
    for (const row of rows) {
      const strategy = row.strategy ?? "default";
      let statement = statements.get(strategy);
      if (!statement) {
        statement = db.query(`
          INSERT INTO ${quoteIdentifier(`drill_scenario_lines_${strategy}`)}(
            drill_name, abstract_line, player_count, depth
          )
          VALUES (?, ?, ?, ?)
        `);
        statements.set(strategy, statement);
      }
      statement.run(row.drillName, row.abstractLine, row.playerCount, row.drillDepth ?? 0);
    }
  } finally {
    for (const statement of statements.values()) {
      statement.finalize();
    }
  }
}

function defaultDrillScenarioLines(dimensions: RangeDimensionFixture[]): DrillScenarioFixtureRow[] {
  const rows: DrillScenarioFixtureRow[] = [];
  const seen = new Set<string>();
  for (const dimension of dimensions) {
    const strategy = dimension.strategy ?? "default";
    const abstractLine = dimension.concreteLines[0]?.abstractLine ?? "R-C";
    const key = `${strategy}:${dimension.playerCount}:${abstractLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      strategy,
      drillName: "fixture",
      abstractLine,
      playerCount: dimension.playerCount,
      drillDepth: 0,
    });
  }
  return rows;
}

function getRangeDataTableName(strategy: string, playerCount: number, depthBb: number): string {
  return `range_data_${strategy}_${playerCount}max_${depthBb}BB`;
}
