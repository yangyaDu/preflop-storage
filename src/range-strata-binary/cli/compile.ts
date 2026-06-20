import { buildRangeStrataBinaryStore } from "../compiler/pipeline";
import { parseCliArgs, getBooleanArg, getNumberArg, getRepeatedStringArgs, getStringArg } from "../../cli/args";
import { parseDimension } from "../../utils/dimension";

const args = parseCliArgs(Bun.argv.slice(2));

const sourceDbPath = getStringArg(args, "source", "range-db/range.db");
const outDir = getStringArg(args, "out", "range-db/range-strata-binary");
const dimensions = getRepeatedStringArgs(args, "dimension").map(parseDimension);
const maxConcreteLinesPerDimension = args["max-packs"] === undefined ? undefined : getNumberArg(args, "max-packs");
const resume = getBooleanArg(args, "resume");
const statsOutPath = args.stats !== undefined && args.stats !== true ? getStringArg(args, "stats") : undefined;
const statsMdPath = args["stats-md"] !== undefined ? getStringArg(args, "stats-md") : undefined;

console.log(`source=${sourceDbPath}`);
console.log(`out=${outDir}`);
if (dimensions.length > 0) {
  console.log(`dimensions=${dimensions.map((item) => `${item.strategy}:${item.playerCount}max:${item.depthBb}BB`).join(",")}`);
}
if (maxConcreteLinesPerDimension !== undefined) {
  console.log(`max-packs=${maxConcreteLinesPerDimension}`);
}
if (resume) {
  console.log(`resume=true (skipping completed dimensions from manifest.json)`);
}
if (statsOutPath || statsMdPath) {
  console.log(`stats=${statsOutPath ?? "(none)"}  stats-md=${statsMdPath ?? "(none)"}`);
}

const report = await buildRangeStrataBinaryStore({
  sourceDbPath,
  outDir,
  overwrite: getBooleanArg(args, "overwrite"),
  resume,
  dimensions,
  maxConcreteLinesPerDimension,
  statsOutPath,
  statsMdPath,
});

console.log("range-strata-binary build completed");
if (report.totals.errorCount > 0) {
  process.exitCode = 1;
}
