import { buildRangeStrataBinaryStore } from "../compiler/pipeline";
import {
  assertKnownArgs,
  parseCliArgs,
  getBooleanArg,
  getPositiveIntegerArg,
  getRepeatedStringArgs,
  getStringArg,
  isHelpRequested,
} from "../../cli/args";
import { parseDimension } from "../../utils/dimension";

const args = parseCliArgs(Bun.argv.slice(2));

if (isHelpRequested(args)) {
  console.log(`Usage: bun run build [options]

Options:
  --source <path>       Source SQLite DB path (default: range-db/range.db)
  --out <path>          Output directory (default: range-db/range-strata-binary)
  --overwrite           Rebuild from scratch and replace generated artifacts
  --resume              Reuse successful dimensions from manifest.json
  --dimension <spec>    Build only one dimension; repeatable. Examples: default:6:100, default_6max_100BB
  --max-packs <n>       Limit packs per dimension for smoke tests
  --stats <path>        Write JSON build stats
  --stats-md <path>     Write Markdown build stats
  --help, --h           Show this help`);
  process.exit(0);
}

assertKnownArgs(args, [
  "source",
  "out",
  "overwrite",
  "resume",
  "dimension",
  "max-packs",
  "stats",
  "stats-md",
  "help",
  "h",
]);

const sourceDbPath = getStringArg(args, "source", "range-db/range.db");
const outDir = getStringArg(args, "out", "range-db/range-strata-binary");
const dimensions = getRepeatedStringArgs(args, "dimension").map(parseDimension);
const maxConcreteLinesPerDimension = args["max-packs"] === undefined ? undefined : getPositiveIntegerArg(args, "max-packs");
const overwrite = getBooleanArg(args, "overwrite");
const resume = getBooleanArg(args, "resume");
if (overwrite && resume) {
  throw new Error("--overwrite and --resume are mutually exclusive. Use --overwrite to rebuild or --resume to continue an interrupted build.");
}
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
  overwrite,
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
