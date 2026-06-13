import {
  dimensionKey,
  getBinFileName,
  getConcreteLinesTableName,
  getDrillScenarioTableName,
  quoteIdentifier,
} from "../../db/naming";

export function getIdxFileName(strategy: string, playerCount: number, depthBb: number): string {
  return `ranges_${strategy}_${playerCount}max_${depthBb}BB.idx`;
}

// Re-export commonly used naming helpers for scheme2 convenience
export { dimensionKey, getBinFileName, getConcreteLinesTableName, getDrillScenarioTableName, quoteIdentifier };
