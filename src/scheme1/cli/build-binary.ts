/**
 * @deprecated Scheme1 build output is retained only for legacy compatibility and comparison.
 * Use src/range-strata-binary/cli/compile.ts for new builds.
 */
import { buildBinaryStore } from "../importer/build-binary-store";
import { parseCliArgs, getBooleanArg, getNumberArg, getRepeatedStringArgs, getStringArg } from "../../cli/args";
import { parseDimension } from "../../utils/dimension";

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
