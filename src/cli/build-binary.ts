import { buildBinaryStore } from "../importer/build-binary-store";
import { parseCliArgs, getBooleanArg, getNumberArg, getRepeatedStringArgs, getStringArg } from "./args";

const args = parseCliArgs(Bun.argv.slice(2));

const sourceDbPath = getStringArg(args, "source", "range-db/range.db");
const outDir = getStringArg(args, "out", "range-db/binary");
const dimensions = getRepeatedStringArgs(args, "dimension").map(parseDimension);
const maxConcreteLinesPerDimension = args["max-packs"] === undefined ? undefined : getNumberArg(args, "max-packs");

console.log(`source=${sourceDbPath}`);
console.log(`out=${outDir}`);
if (dimensions.length > 0) {
  console.log(`dimensions=${dimensions.map((item) => `${item.strategy}:${item.playerCount}max:${item.depthBb}BB`).join(",")}`);
}
if (maxConcreteLinesPerDimension !== undefined) {
  console.log(`max-packs=${maxConcreteLinesPerDimension}`);
}

await buildBinaryStore({
  sourceDbPath,
  outDir,
  overwrite: getBooleanArg(args, "overwrite"),
  dimensions,
  maxConcreteLinesPerDimension,
});

console.log("binary build completed");

function parseDimension(value: string): { strategy: string; playerCount: number; depthBb: number } {
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
