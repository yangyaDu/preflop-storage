import { rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { RangeDimension } from "../../db/naming";
import { getIdxFileName } from "../db/naming";
import type { BuildManifest } from "./build-types";

export async function cleanupPreviousOutput(params: {
  outDir: string;
  metaPath: string;
  manifestPath: string;
  manifest: BuildManifest | null;
  dimensions: RangeDimension[];
}): Promise<void> {
  const outRoot = resolve(params.outDir);
  const paths = new Set<string>([
    params.metaPath,
    `${params.metaPath}-wal`,
    `${params.metaPath}-shm`,
    params.manifestPath,
  ]);

  for (const file of params.manifest?.files ?? []) {
    if (file === "meta.db") continue;
    const filePath = resolveOutputPath(outRoot, file);
    if (filePath) paths.add(filePath);
  }

  for (const dimension of params.dimensions) {
    const binFile = resolveOutputPath(outRoot, dimension.binFile);
    const idxFile = resolveOutputPath(outRoot, getIdxFileName(dimension.strategy, dimension.playerCount, dimension.depthBb));

    if (binFile) {
      paths.add(binFile);
      paths.add(`${binFile}.tmp`);
    }

    if (idxFile) {
      paths.add(idxFile);
      paths.add(`${idxFile}.tmp`);
    }
  }

  for (const path of paths) {
    await removeFileWithRetry(path);
  }
}

function resolveOutputPath(outRoot: string, file: string): string | null {
  const filePath = resolve(outRoot, file);
  const relativePath = relative(outRoot, filePath);

  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    return filePath;
  }

  return null;
}

async function removeFileWithRetry(path: string): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await rm(path, { force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveRetry) => setTimeout(resolveRetry, 50));
    }
  }

  throw lastError;
}
