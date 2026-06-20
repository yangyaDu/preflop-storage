import { checkManifestFile, checkFilesExist } from "./checks/manifest";
import { checkCatalog } from "./checks/catalog";
import { checkIndexHeader } from "./checks/index-header";
import { checkPackHeader } from "./checks/pack-header";
import { checkIndexPackCross, type IndexPackCrossOptions } from "./checks/index-pack-cross";
import {
  createReport,
  writeJsonReport,
  writeMdReport,
  type RangeStrataVerifyReport,
  type VerifyFailure,
  type DimensionVerifyDetail,
} from "./report";
import { collectIndexInfo } from "./checks/index-header";
import { getActionSchemaIds } from "./checks/catalog";

export interface StandaloneVerifyOptions {
  dir: string;
  verifyChecksums: boolean;
  outPath?: string;
  mdPath?: string;
}

export async function runStandaloneVerify(options: StandaloneVerifyOptions): Promise<RangeStrataVerifyReport> {
  const { dir, verifyChecksums } = options;
  const failures: VerifyFailure[] = [];

  // ── Step 0: manifest.json parse ───────────────────────────
  const manifestResult = checkManifestFile(dir);
  if ("reason" in manifestResult) {
    // Manifest itself is broken — can't proceed
    failures.push(manifestResult);
    const report = createReport("standalone", dir, undefined, verifyChecksums, [], failures);
    writeReports(report, options);
    return report;
  }

  const ctx = manifestResult; // { dir, manifest }

  // ── Step 0: file existence ────────────────────────────────
  const fileResults = checkFilesExist(ctx);
  failures.push(...fileResults.failures);

  // ── Step 1: catalog metadata ──────────────────────────────
  const catalogResults = checkCatalog(ctx.dir, ctx.manifest);
  failures.push(...catalogResults.failures);

  // ── Step 2: action_schema FK set ──────────────────────────
  const validActionSchemaIds = getActionSchemaIds(ctx.dir);

  // ── Step 3: index header ──────────────────────────────────
  const indexHeaderResults = checkIndexHeader(ctx.dir, ctx.manifest, validActionSchemaIds);
  failures.push(...indexHeaderResults.failures);

  // ── Step 4: pack header ───────────────────────────────────
  const packHeaderResults = checkPackHeader(ctx.dir, ctx.manifest);
  failures.push(...packHeaderResults.failures);

  // ── Step 5: index ↔ pack cross-reference ──────────────────
  const crossOptions: IndexPackCrossOptions = { verifyChecksums };
  const indexPackCrossResults = checkIndexPackCross(ctx.dir, ctx.manifest, crossOptions);
  failures.push(...indexPackCrossResults.failures);

  // ── Build dimension details ───────────────────────────────
  const indexInfo = collectIndexInfo(ctx.dir, ctx.manifest);
  const dimensions: DimensionVerifyDetail[] = indexInfo.map((info) => {
    const dimFailures = failures.filter((f) =>
      f.check === `dimension:${info.strategy}:${info.playerCount}max:${info.depthBb}BB`,
    );
    const binFailures = dimFailures.filter((f) => f.layer === "pack-header").length;
    const idxStructFailures = dimFailures.filter((f) => f.layer === "index-header").length;
    const indexPackCrossFailures = dimFailures.filter((f) => f.layer === "index-pack-cross").length;

    return {
      strategy: info.strategy,
      playerCount: info.playerCount,
      depthBb: info.depthBb,
      checked: info.recordCount > 0 || dimFailures.some((f) => f.reason !== "MISSING_FILE"),
      indexRecords: info.recordCount,
      binFileSizeBytes: 0,
      idxFileSizeBytes: 0,
      headerFailures: binFailures + idxStructFailures,
      indexPackCrossFailures,
    };
  });

  const report = createReport("standalone", dir, undefined, verifyChecksums, dimensions, failures);
  writeReports(report, options);
  return report;
}

function writeReports(report: RangeStrataVerifyReport, options: StandaloneVerifyOptions): void {
  if (options.outPath) {
    try {
      writeJsonReport(report, options.outPath);
      console.log(`JSON report written to ${options.outPath}`);
    } catch (e) {
      console.error(`Failed to write JSON report: ${e}`);
    }
  }
  if (options.mdPath) {
    try {
      writeMdReport(report, options.mdPath);
      console.log(`Markdown report written to ${options.mdPath}`);
    } catch (e) {
      console.error(`Failed to write Markdown report: ${e}`);
    }
  }
}
