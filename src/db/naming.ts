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
    binFile: `ranges_${strategy}_${playerCount}max_${depthBb}BB.bin`,
  };
}

export function dimensionKey(params: Pick<RangeDimension, "strategy" | "playerCount" | "depthBb">): string {
  return `${params.strategy}:${params.playerCount}max:${params.depthBb}BB`;
}

export function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQLite identifier: ${identifier}`);
  }

  return `"${identifier}"`;
}
