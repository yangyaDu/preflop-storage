import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const projectRoot = join(import.meta.dir, "..");
const scriptPath = join(projectRoot, "scripts", "build-native.ts");

describe("native build script", () => {
  test("lists supported targets", async () => {
    const result = await runNativeBuildScript(["--list-targets"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("x86_64-pc-windows-msvc");
    expect(result.stdout).toContain("x86_64-unknown-linux-gnu");
    expect(result.stdout).toContain("aarch64-apple-darwin");
    expect(result.stdout).toContain("x86_64-apple-darwin");
  });

  test("prints a dry-run build command for an explicit target", async () => {
    const result = await runNativeBuildScript(["--target", "x86_64-pc-windows-msvc", "--dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Native addon target: Windows x64 MSVC");
    expect(result.stdout).toContain("Expected artifact: native-addon/preflop-storage-native.win32-x64-msvc.node");
    expect(result.stdout).toContain(
      "Dry run: bunx @napi-rs/cli build --platform --release --target x86_64-pc-windows-msvc",
    );
  });

  test("accepts an npm-style argument separator", async () => {
    const result = await runNativeBuildScript(["--", "--target", "x86_64-pc-windows-msvc", "--dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Dry run: bunx @napi-rs/cli build");
  });

  test("rejects unsupported targets with a concise error", async () => {
    const result = await runNativeBuildScript(["--target", "x86_64-pc-windows-gnu", "--dry-run"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unsupported native target: x86_64-pc-windows-gnu");
    expect(result.stderr).toContain("Supported native targets:");
    expect(result.stderr).not.toContain("at selectTarget");
  });
});

async function runNativeBuildScript(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn([process.execPath, scriptPath, ...args], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return {
    exitCode,
    stdout: await stdout,
    stderr: await stderr,
  };
}
