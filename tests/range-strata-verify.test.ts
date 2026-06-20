import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { buildRangeStrataBinaryStore } from "../src/range-strata-binary/importer/build-binary-store";
import { runStandaloneVerify } from "../src/range-strata-binary/verify/standalone";
const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function buildFixture(
  options: { secondActionName?: string; stats?: boolean } = {},
): Promise<{ outDir: string; sourcePath: string }> {
  const rootDir = await mkdtemp(join(tmpdir(), "pfs-verify-"));
  tempDirs.push(rootDir);

  const sourcePath = join(rootDir, "range.db");
  const outDir = join(rootDir, "range-strata-binary");
  const secondActionName = options.secondActionName ?? "raise";

  const db = new Database(sourcePath);
  try {
    db.exec(`
      CREATE TABLE concrete_lines_default_6max_100BB (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        abstract_line TEXT NOT NULL, concrete_line TEXT NOT NULL,
        UNIQUE(abstract_line, concrete_line)
      );
      CREATE TABLE drill_scenario_lines_default (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        drill_name TEXT NOT NULL, abstract_line TEXT NOT NULL,
        player_count INTEGER NOT NULL, depth INTEGER NOT NULL
      );
      CREATE TABLE range_data_default_6max_100BB (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        concrete_line_id INTEGER NOT NULL, hole_cards TEXT NOT NULL,
        action_name TEXT NOT NULL, action_size REAL NOT NULL,
        amount_bb REAL NOT NULL, frequency REAL NOT NULL, hand_ev REAL
      );
    `);

    db.query(
      "INSERT INTO concrete_lines_default_6max_100BB(id, abstract_line, concrete_line) VALUES (1, 'R-C', 'R2-C'), (2, 'R-C', 'R3-C')",
    ).run();
    db.query("INSERT INTO drill_scenario_lines_default(drill_name, abstract_line, player_count, depth) VALUES ('fixture', 'R-C', 6, 0)").run();
    db.query(
      "INSERT INTO range_data_default_6max_100BB(concrete_line_id, hole_cards, action_name, action_size, amount_bb, frequency, hand_ev) VALUES (1, 'AA', 'fold', 0, 0, 1, 0)",
    ).run();
    db.query(
      "INSERT INTO range_data_default_6max_100BB(concrete_line_id, hole_cards, action_name, action_size, amount_bb, frequency, hand_ev) VALUES (2, 'AKs', ?, 40, 2, 0.5, 5)",
    ).run(secondActionName);
  } finally {
    db.close();
  }

  await buildRangeStrataBinaryStore({
    sourceDbPath: sourcePath,
    outDir,
    overwrite: true,
    maxConcreteLinesPerDimension: 10,
    statsOutPath: options.stats ? join(rootDir, "reports", "build-stats.json") : undefined,
    statsMdPath: options.stats ? join(rootDir, "reports", "build-stats.md") : undefined,
  });

  return { outDir, sourcePath };
}

describe("Range Strata Binary standalone verify", () => {
  test("passes on a clean build output", async () => {
    const { outDir } = await buildFixture();
    const report = await runStandaloneVerify({ dir: outDir, verifyChecksums: false });

    expect(report.totals.manifestOk).toBe(true);
    expect(report.totals.metaDbOk).toBe(true);
    expect(report.totals.idxFilesOk).toBeGreaterThan(0);
    expect(report.totals.idxFilesFailed).toBe(0);
    expect(report.totals.binFilesOk).toBeGreaterThan(0);
    expect(report.totals.binFilesFailed).toBe(0);
    expect(report.failures.length).toBe(0);
  });

  test("passes on clean build with CRC checksums enabled", async () => {
    const { outDir } = await buildFixture();
    const report = await runStandaloneVerify({ dir: outDir, verifyChecksums: true });

    expect(report.totals.manifestOk).toBe(true);
    expect(report.totals.metaDbOk).toBe(true);
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
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

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
    expect(report.totals.idxFilesFailed).toBeGreaterThan(0);
    expect(report.failures.some((f) => f.reason === "INVALID_MAGIC")).toBe(true);
  });

  test("fails when .bin header magic is corrupted", async () => {
    const { outDir } = await buildFixture();

    const binPath = join(outDir, "ranges_default_6max_100BB.bin");
    const raw = new Uint8Array(readFileSync(binPath).buffer);
    raw[0] = 0; // Corrupt magic
    writeFileSync(binPath, raw);

    const report = await runStandaloneVerify({ dir: outDir, verifyChecksums: false });
    expect(report.totals.binFilesFailed).toBeGreaterThan(0);
    expect(report.failures.some((f) => f.reason === "INVALID_HEADER" && f.layer === "bin-structure")).toBe(true);
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
    expect(report.failures.some((f) => f.reason === "CHECKSUM_MISMATCH" && f.layer === "meta-db")).toBe(true);
  });

  test("counts idx-bin cross-reference failures in totals", async () => {
    const { outDir } = await buildFixture();
    const idxPath = join(outDir, "ranges_default_6max_100BB.idx");
    const raw = readFileSync(idxPath);

    // First record byteLength lives at header(16) + record field offset(14).
    raw.writeUInt32LE(1, 16 + 14);
    writeFileSync(idxPath, raw);

    const report = await runStandaloneVerify({ dir: outDir, verifyChecksums: false });
    expect(report.failures.some((f) => f.layer === "idx-bin-cross" && f.reason === "PACK_SIZE_MISMATCH")).toBe(true);
    expect(report.totals.idxBinCrossFailures).toBeGreaterThan(0);
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

    const jsonContent = JSON.parse(readFileSync(outPath, "utf-8"));
    expect(jsonContent.mode).toBe("standalone");
    expect(jsonContent.totals.manifestOk).toBe(true);

    const mdContent = readFileSync(mdPath, "utf-8");
    expect(mdContent).toContain("Range Strata Binary Verify Report");
    expect(mdContent).toContain("All checks passed");
  });
});

describe("Range Strata Binary cross verify", () => {
  test("cross mode sampling passes on clean build", async () => {
    const { outDir, sourcePath } = await buildFixture();

    const { runCrossVerify } = await import("../src/range-strata-binary/verify/cross");
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
    expect(report.totals.metaDbOk).toBe(true);
    // Cross-check should have no failures
    expect((report.totals.failedSourceRecords ?? 0)).toBe(0);
    expect((report.totals.extraBinaryRecords ?? 0)).toBe(0);

    expect(existsSync(outPath)).toBe(true);
    const jsonContent = JSON.parse(readFileSync(outPath, "utf-8"));
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

    const { runCrossVerify } = await import("../src/range-strata-binary/verify/cross");
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
