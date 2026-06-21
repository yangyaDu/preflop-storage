import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempDirRegistry {
  make: (prefix: string) => Promise<string>;
  register: (dir: string) => void;
  cleanup: () => Promise<void>;
}

export function createTempDirRegistry(): TempDirRegistry {
  const dirs: string[] = [];

  return {
    make: async (prefix: string): Promise<string> => {
      const dir = await mkdtemp(join(tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    },
    register: (dir: string): void => {
      dirs.push(dir);
    },
    cleanup: async (): Promise<void> => {
      while (dirs.length > 0) {
        const dir = dirs.pop();
        if (dir) await removeTempDirWithRetry(dir).catch(() => {});
      }
    },
  };
}

export async function removeTempDirWithRetry(dir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}
