import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { runStandaloneVerify } from "../src/range-strata-binary/integrity/self-check";
import { createBuiltRangeDbFixtureInRoot, type RangeDimensionFixture } from "./helpers/range-db-fixture";
import { createTempDirRegistry } from "./helpers/temp-dir";

interface ManifestJson {
  dimensions: Array<Record<string, unknown>>;
}

interface VerifyReportJson {
  mode: "standalone" | "cross";
  totals: {
    manifestOk: boolean;
  };
}

const tempDirs = createTempDirRegistry();

afterEach(tempDirs.cleanup);

async function buildFixture(
  options: { secondActionName?: string; stats?: boolean } = {},
): Promise<{ outDir: string; sourcePath: string }> {
  const rootDir = await tempDirs.make("pfs-verify-");
  const secondActionName = options.secondActionName ?? "raise";
  const { outDir, sourcePath } = await createBuiltRangeDbFixtureInRoot(rootDir, {
    dimensions: [verifyDimension(secondActionName)],
  }, {
    maxConcreteLinesPerDimension: 10,
    statsOutPath: options.stats ? join(rootDir, "reports", "build-stats.json") : undefined,
    statsMdPath: options.stats ? join(rootDir, "reports", "build-stats.md") : undefined,
  });

  return { outDir, sourcePath };
}

function verifyDimension(secondActionName: string): RangeDimensionFixture {
  return {
    playerCount: 6,
    depthBb: 100,
    concreteLines: [
      { id: 1, abstractLine: "R-C", concreteLine: "R2-C" },
      { id: 2, abstractLine: "R-C", concreteLine: "R3-C" },
    ],
    rangeRows: [
      { concreteLineId: 1, holeCards: "AA", actionName: "fold", actionSize: 0, amountBb: 0, frequency: 1, handEv: 0 },
      {
        concreteLineId: 2,
        holeCards: "AKs",
        actionName: secondActionName,
        actionSize: 40,
        amountBb: 2,
        frequency: 0.5,
        handEv: 5,
      },
    ],
  };
}

describe("Range Strata Binary standalone verify", () => {
  test("passes on a clean build output", async () => {
    const { outDir } = await buildFixture();
    const report = await runStandaloneVerify({ dir: outDir, verifyChecksums: false });

    expect(report.totals.manifestOk).toBe(true);
    expect(report.totals.catalogOk).toBe(true);
    expect(report.totals.indexFilesOk).toBeGreaterThan(0);
    expect(report.totals.indexFilesFailed).toBe(0);
    expect(report.totals.packFilesOk).toBeGreaterThan(0);
    expect(report.totals.packFilesFailed).toBe(0);
    expect(report.failures.length).toBe(0);
  });

  test("passes on clean build with CRC checksums enabled", async () => {
    const { outDir } = await buildFixture();
    const report = await runStandaloneVerify({ dir: outDir, verifyChecksums: true });

    expect(report.totals.manifestOk).toBe(true);
    expect(report.totals.catalogOk).toBe(true);
    expect(report.failures.length).toBe(0);
  });

  test("fails when manifest.json is missing", async () => {
    const { outDir } = await buildFixture();

    // Remove manifest.json
    await rm(join(outDir, "manifest.json"), { force: true });

    const report = await runStandaloneVerify({ dir: outDir, verifyChecksums: false });
    expect(report.totals.manifestOk).toBe(false);
    expect(report.failures.some((f) => f.reason === "MISSING_FILE" && f.check === "manifest.json")).toBe(true);
  });

  test("fails when manifest.json is corrupted JSON", async () => {
    const { outDir } = await buildFixture();
    writeFileSync(join(outDir, "manifest.json"), "{not valid json");

    const report = await runStandaloneVerify({ dir: outDir, verifyChecksums: false });
    expect(report.totals.manifestOk).toBe(false);
    expect(report.failures.some((f) => f.reason === "INVALID_JSON")).toBe(true);
  });

  test("fails when manifest has duplicate dimensions", async () => {
    const { outDir } = await buildFixture();
    const manifestPath = join(outDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as ManifestJson;

    // Duplicate a dimension
    manifest.dimensions.push({ ...manifest.dimensions[0] });
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const report = await runStandaloneVerify({ dir: outDir, verifyChecksums: false });
    expect(report.failures.some((f) => f.reason === "DUPLICATE")).toBe(true);
  });

  test("fails when .idx file is missing for a dimension", async () => {
    const { outDir } = await buildFixture();

    // Remove a .idx file
    const idxPath = join(outDir, "ranges_default_6max_100BB.idx");
    if (existsSync(idxPath)) await rm(idxPath, { force: true });

    const report = await runStandaloneVerify({ dir: outDir, verifyChecksums: false });
    expect(report.failures.some((f) => f.reason === "MISSING_FILE" && f.layer === "file-existence")).toBe(true);
  });

  test("fails when .idx magic is corrupted", async () => {
    const { outDir } = await buildFixture();

    const idxPath = join(outDir, "ranges_default_6max_100BB.idx");
    const raw = new Uint8Array(readFileSync(idxPath).buffer);
    raw[0] = 0; // Corrupt magic
    writeFileSync(idxPath, raw);

    const report = await runStandaloneVerify({ dir: outDir, verifyChecksums: false });
    expect(report.totals.indexFilesFailed).toBeGreaterThan(0);
    expect(report.failures.some((f) => f.reason === "INVALID_MAGIC")).toBe(true);
  });

  test("fails when .bin header magic is corrupted", async () => {
    const { outDir } = await buildFixture();

    const binPath = join(outDir, "ranges_default_6max_100BB.bin");
    const raw = new Uint8Array(readFileSync(binPath).buffer);
    raw[0] = 0; // Corrupt magic
    writeFileSync(binPath, raw);

    const report = await runStandaloneVerify({ dir: outDir, verifyChecksums: false });
    expect(report.totals.packFilesFailed).toBeGreaterThan(0);
    expect(report.failures.some((f) => f.reason === "INVALID_HEADER" && f.layer === "pack-header")).toBe(true);
  });

  test("fails when meta.db action_schema checksum is wrong", async () => {
    const { outDir } = await buildFixture();

    // Corrupt an action_blob in meta.db
    const db = new Database(join(outDir, "meta.db"));
    try {
      const schemas = db.query("SELECT id, action_blob, checksum FROM action_schemas ORDER BY id LIMIT 1").all() as Array<{
        id: number;
        action_blob: Buffer;
        checksum: number;
      }>;
      if (schemas.length > 0) {
        // Write wrong checksum
        db.query("UPDATE action_schemas SET checksum = 0 WHERE id = ?").run(schemas[0].id);
      }
    } finally {
      db.close();
    }

    const report = await runStandaloneVerify({ dir: outDir, verifyChecksums: false });
    expect(report.failures.some((f) => f.reason === "CHECKSUM_MISMATCH" && f.layer === "catalog")).toBe(true);
  });

  test("counts index-pack cross-reference failures in totals", async () => {
    const { outDir } = await buildFixture();
    const idxPath = join(outDir, "ranges_default_6max_100BB.idx");
    const raw = readFileSync(idxPath);

    // First record byteLength lives at header(16) + record field offset(14).
    raw.writeUInt32LE(1, 16 + 14);
    writeFileSync(idxPath, raw);

    const report = await runStandaloneVerify({ dir: outDir, verifyChecksums: false });
    expect(report.failures.some((f) => f.layer === "index-pack-cross" && f.reason === "PACK_SIZE_MISMATCH")).toBe(true);
    expect(report.totals.indexPackCrossFailures).toBeGreaterThan(0);
  });

  test("reports idx out-of-order as failure", async () => {
    const { outDir } = await buildFixture({ secondActionName: "raise" });

    const idxPath = join(outDir, "ranges_default_6max_100BB.idx");
    const raw = new Uint8Array(readFileSync(idxPath).buffer);
    expect(raw.byteLength).toBeGreaterThanOrEqual(16 + 2 * 22);

    // Swap records 0 and 1 in the concreteLineId fields
    const rec0Off = 16;
    const rec1Off = 16 + 22;
    const tmp = raw.slice(rec0Off, rec0Off + 4);
    raw.set(raw.slice(rec1Off, rec1Off + 4), rec0Off);
    raw.set(tmp, rec1Off);
    writeFileSync(idxPath, raw);

    const report = await runStandaloneVerify({ dir: outDir, verifyChecksums: false });
    expect(report.failures.some((f) => f.reason === "OUT_OF_ORDER")).toBe(true);
  });

  test("writes JSON and Markdown reports", async () => {
    const { outDir } = await buildFixture();
    const outPath = join(outDir, "report.json");
    const mdPath = join(outDir, "report.md");

    await runStandaloneVerify({ dir: outDir, verifyChecksums: false, outPath, mdPath });

    expect(existsSync(outPath)).toBe(true);
    expect(existsSync(mdPath)).toBe(true);

    const jsonContent = JSON.parse(readFileSync(outPath, "utf-8")) as VerifyReportJson;
    expect(jsonContent.mode).toBe("standalone");
    expect(jsonContent.totals.manifestOk).toBe(true);

    const mdContent = readFileSync(mdPath, "utf-8");
    expect(mdContent).toContain("Range Strata Binary Integrity Report");
    expect(mdContent).toContain("All checks passed");
  });
});

describe("Range Strata Binary cross verify", () => {
  test("cross mode sampling passes on clean build", async () => {
    const { outDir, sourcePath } = await buildFixture();

    const { runCrossVerify } = await import("../src/range-strata-binary/integrity/cross-check");
    const outPath = join(outDir, "cross-report.json");

    const report = await runCrossVerify({
      dir: outDir,
      sourceDbPath: sourcePath,
      sampleSize: 100,
      maxFailures: 50,
      verifyChecksums: true,
      outPath,
    });

    expect(report.totals.manifestOk).toBe(true);
    expect(report.totals.catalogOk).toBe(true);
    // Cross-check should have no failures
    expect((report.totals.failedSourceRecords ?? 0)).toBe(0);
    expect((report.totals.extraBinaryRecords ?? 0)).toBe(0);

    expect(existsSync(outPath)).toBe(true);
    const jsonContent = JSON.parse(readFileSync(outPath, "utf-8")) as VerifyReportJson;
    expect(jsonContent.mode).toBe("cross");
  });

  test("cross mode fails when source value moves to a different Float32 inside legacy tolerance", async () => {
    const { outDir, sourcePath } = await buildFixture();

    const db = new Database(sourcePath);
    try {
      db.query(`
        UPDATE range_data_default_6max_100BB
        SET frequency = ?
        WHERE concrete_line_id = 2
          AND hole_cards = 'AKs'
      `).run(0.5000000596046448);
    } finally {
      db.close();
    }

    const { runCrossVerify } = await import("../src/range-strata-binary/integrity/cross-check");
    const report = await runCrossVerify({
      dir: outDir,
      sourceDbPath: sourcePath,
      sampleSize: 0,
      maxFailures: 50,
      verifyChecksums: true,
    });

    expect(report.totals.failedSourceRecords).toBeGreaterThan(0);
    expect(report.failures.some((failure) => failure.reason === "FREQUENCY_FLOAT32_MISMATCH")).toBe(true);
    expect(report.precision?.frequency.mismatchValues).toBeGreaterThan(0);
    expect(report.precision?.frequency.maxImplementationAbsError).toBeGreaterThan(0);
  });
});
