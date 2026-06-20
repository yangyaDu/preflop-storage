import { checkManifestFile, checkFilesExist } from "./checks/manifest";
import { checkMetaDb } from "./checks/meta-db";
import { checkIdxStructure } from "./checks/idx-structure";
import { checkBinStructure } from "./checks/bin-structure";
import { checkIdxBinCross, type IdxBinCrossOptions } from "./checks/idx-bin-cross";
import {
  createReport,
  writeJsonReport,
  writeMdReport,
  type RangeStrataVerifyReport,
  type VerifyFailure,
  type DimensionVerifyDetail,
} from "./report";
import { collectIdxInfo } from "./checks/idx-structure";
import { getActionSchemaIds } from "./checks/meta-db";

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

  // ── Step 1: meta.db ───────────────────────────────────────
  const metaResults = checkMetaDb(ctx.dir, ctx.manifest);
  failures.push(...metaResults.failures);

  // ── Step 2: action_schema FK set ──────────────────────────
  const validActionSchemaIds = getActionSchemaIds(ctx.dir);

  // ── Step 3: .idx structure ────────────────────────────────
  const idxResults = checkIdxStructure(ctx.dir, ctx.manifest, validActionSchemaIds);
  failures.push(...idxResults.failures);

  // ── Step 4: .bin structure ────────────────────────────────
  const binResults = checkBinStructure(ctx.dir, ctx.manifest);
  failures.push(...binResults.failures);

  // ── Step 5: .idx ↔ .bin cross-reference ───────────────────
  const crossOptions: IdxBinCrossOptions = { verifyChecksums };
  const crossResults = checkIdxBinCross(ctx.dir, ctx.manifest, crossOptions);
  failures.push(...crossResults.failures);

  // ── Build dimension details ───────────────────────────────
  const idxInfo = collectIdxInfo(ctx.dir, ctx.manifest);
  const dimensions: DimensionVerifyDetail[] = idxInfo.map((info) => {
    const dimFailures = failures.filter((f) =>
      f.check === `dimension:${info.strategy}:${info.playerCount}max:${info.depthBb}BB`,
    );
    const binFailures = dimFailures.filter((f) => f.layer === "bin-structure").length;
    const idxStructFailures = dimFailures.filter((f) => f.layer === "idx-structure").length;
    const idxBinCrossFailures = dimFailures.filter((f) => f.layer === "idx-bin-cross").length;

    return {
      strategy: info.strategy,
      playerCount: info.playerCount,
      depthBb: info.depthBb,
      checked: info.recordCount > 0 || dimFailures.some((f) => f.reason !== "MISSING_FILE"),
      idxRecords: info.recordCount,
      binFileSizeBytes: 0,
      idxFileSizeBytes: 0,
      structureFailures: binFailures + idxStructFailures,
      idxBinCrossFailures,
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
