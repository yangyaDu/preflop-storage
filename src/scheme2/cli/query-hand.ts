import { Scheme2QueryService } from "../query/query-service";
import { getBooleanArg, getNumberArg, getStringArg, parseCliArgs } from "../../cli/args";

const args = parseCliArgs(Bun.argv.slice(2));

const binaryDir = getStringArg(args, "dir", "range-db/binary-scheme2");
const metaPath = getStringArg(args, "meta", `${binaryDir}/meta.db`);
const service = new Scheme2QueryService(metaPath, binaryDir, {
  verifyChecksums: getBooleanArg(args, "verify-checksum"),
});

try {
  const result = await service.getHandStrategy({
    strategy: getStringArg(args, "strategy", "default"),
    playerCount: getNumberArg(args, "player-count"),
    depthBb: getNumberArg(args, "depth-bb"),
    concreteLineId: getNumberArg(args, "concrete-line-id"),
    holeCards: getStringArg(args, "hand"),
  });

  console.log(JSON.stringify(result, null, 2));
} finally {
  await service.close();
}
