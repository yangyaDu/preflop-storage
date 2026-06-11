export interface RangeDimension {
  strategy: string;
  playerCount: number;
  depthBb: number;
  rangeTable: string;
  concreteTable: string;
  binFile: string;
}

const RANGE_TABLE_PATTERN = /^range_data_(.+)_([0-9]+)max_([0-9]+)BB$/;

export function parseRangeDataTableName(rangeTable: string): RangeDimension | null {
  const match = rangeTable.match(RANGE_TABLE_PATTERN);
  if (!match) return null;

  const [, strategy, playerCountText, depthBbText] = match;
  const playerCount = Number(playerCountText);
  const depthBb = Number(depthBbText);

  return {
    strategy,
    playerCount,
    depthBb,
    rangeTable,
    concreteTable: `concrete_lines_${strategy}_${playerCount}max_${depthBb}BB`,
    binFile: getBinFileName(strategy, playerCount, depthBb),
  };
}

export function dimensionKey(params: Pick<RangeDimension, "strategy" | "playerCount" | "depthBb">): string {
  return `${params.strategy}:${params.playerCount}max:${params.depthBb}BB`;
}

export function getDrillScenarioTableName(strategy: string): string {
  return `drill_scenario_lines_${strategy}`;
}

export function getConcreteLinesTableName(strategy: string, playerCount: number, depthBb: number): string {
  return `concrete_lines_${strategy}_${playerCount}max_${depthBb}BB`;
}

export function getRangePackIndexTableName(strategy: string, playerCount: number, depthBb: number): string {
  return `range_pack_index_${strategy}_${playerCount}max_${depthBb}BB`;
}

export function getBinFileName(strategy: string, playerCount: number, depthBb: number): string {
  return `ranges_${strategy}_${playerCount}max_${depthBb}BB.bin`;
}

export function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQLite identifier: ${identifier}`)
  }

  return `"${identifier}"`;
}
