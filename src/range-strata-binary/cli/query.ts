import { RangeStrataQueryService } from "../query/service";
import {
  assertKnownArgs,
  getBooleanArg,
  getPositiveIntegerArg,
  getStringArg,
  isHelpRequested,
  parseCliArgs,
} from "../../cli/args";

const args = parseCliArgs(Bun.argv.slice(2));

if (isHelpRequested(args)) {
  console.log(`Usage: bun run query --player-count <n> --depth-bb <bb> --concrete-line-id <id> --hand <code> [options]

Options:
  --dir <path>              Range Strata Binary output directory (default: range-db/range-strata-binary)
  --meta <path>             meta.db path (default: <dir>/meta.db)
  --strategy <name>         Strategy name (default: default)
  --player-count <n>        Player count, positive integer
  --depth-bb <bb>           Stack depth in BB, positive integer
  --concrete-line-id <id>   Concrete line id, positive integer
  --hand <code>             Hand code such as AA, AKs, AKo
  --verify-checksum         Verify pack CRC32C before decoding
  --help, --h               Show this help`);
  process.exit(0);
}

assertKnownArgs(args, [
  "dir",
  "meta",
  "strategy",
  "player-count",
  "depth-bb",
  "concrete-line-id",
  "hand",
  "verify-checksum",
  "help",
  "h",
]);

const binaryDir = getStringArg(args, "dir", "range-db/range-strata-binary");
const metaPath = getStringArg(args, "meta", `${binaryDir}/meta.db`);
const service = new RangeStrataQueryService(metaPath, binaryDir, {
  verifyChecksums: getBooleanArg(args, "verify-checksum"),
});

try {
  const result = await service.getHandStrategy({
    strategy: getStringArg(args, "strategy", "default"),
    playerCount: getPositiveIntegerArg(args, "player-count"),
    depthBb: getPositiveIntegerArg(args, "depth-bb"),
    concreteLineId: getPositiveIntegerArg(args, "concrete-line-id"),
    holeCards: getStringArg(args, "hand"),
  });

  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(formatCliError(error));
  process.exitCode = 1;
} finally {
  try {
    await service.close();
  } catch (error) {
    console.error(`Failed to close query service: ${formatCliError(error)}`);
    process.exitCode = 1;
  }
}

function formatCliError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
