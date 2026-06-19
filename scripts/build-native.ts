import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseCliArgs } from "../src/cli/args";

interface NativeTarget {
  target: string;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  artifact: string;
  label: string;
}

const TARGETS: NativeTarget[] = [
  {
    target: "x86_64-pc-windows-msvc",
    platform: "win32",
    arch: "x64",
    artifact: "preflop-storage-native.win32-x64-msvc.node",
    label: "Windows x64 MSVC",
  },
  {
    target: "x86_64-unknown-linux-gnu",
    platform: "linux",
    arch: "x64",
    artifact: "preflop-storage-native.linux-x64-gnu.node",
    label: "Linux x64 GNU",
  },
  {
    target: "aarch64-apple-darwin",
    platform: "darwin",
    arch: "arm64",
    artifact: "preflop-storage-native.darwin-arm64.node",
    label: "macOS Apple Silicon",
  },
  {
    target: "x86_64-apple-darwin",
    platform: "darwin",
    arch: "x64",
    artifact: "preflop-storage-native.darwin-x64.node",
    label: "macOS Intel",
  },
];

const args = parseCliArgs(Bun.argv.slice(2).filter((token) => token !== "--"));

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function main(): Promise<void> {
  if (args.help) {
    printHelp();
    return;
  }

  if (args["list-targets"]) {
    printTargets();
    return;
  }

  const nativeDir = join(import.meta.dir, "..", "native-addon");
  const selectedTarget = selectTarget();

  console.log(`Native addon target: ${selectedTarget.label} (${selectedTarget.target})`);
  console.log(`Expected artifact: native-addon/${selectedTarget.artifact}`);

  const command = [
    "bunx",
    "@napi-rs/cli",
    "build",
    "--platform",
    "--release",
    "--target",
    selectedTarget.target,
  ];

  if (args["dry-run"]) {
    console.log(`Dry run: ${command.join(" ")}`);
    return;
  }

  const proc = Bun.spawn(command, {
    cwd: nativeDir,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) process.exit(exitCode);

  const artifactPath = join(nativeDir, selectedTarget.artifact);
  if (!existsSync(artifactPath)) {
    throw new Error(`Native build finished, but artifact was not found: ${artifactPath}`);
  }

  console.log(`Native addon built: ${artifactPath}`);
}

function selectTarget(): NativeTarget {
  const explicitTarget = getStringArg("target");
  if (explicitTarget) {
    const target = TARGETS.find((candidate) => candidate.target === explicitTarget);
    if (!target) {
      throw new Error(`Unsupported native target: ${explicitTarget}\n\n${formatTargetList()}`);
    }
    return target;
  }

  const current = TARGETS.find((target) => target.platform === process.platform && target.arch === process.arch);
  if (!current) {
    throw new Error(
      `Unsupported current platform: ${process.platform}/${process.arch}\n\nPass --target explicitly, or add this platform to scripts/build-native.ts.\n\n${formatTargetList()}`,
    );
  }
  return current;
}

function getStringArg(key: string): string | null {
  const value = args[key];
  if (Array.isArray(value)) return value[value.length - 1];
  if (typeof value === "string") return value;
  return null;
}

function printHelp(): void {
  console.log(`Usage:
  bun run build:native
  bun run build:native -- --target x86_64-pc-windows-msvc
  bun run build:native -- --list-targets
  bun run build:native -- --dry-run

By default, the script selects the current platform target. Windows x64 always uses MSVC.`);
}

function printTargets(): void {
  console.log(formatTargetList());
}

function formatTargetList(): string {
  return [
    "Supported native targets:",
    ...TARGETS.map((target) => `  - ${target.target} (${target.label}) -> ${target.artifact}`),
  ].join("\n");
}
