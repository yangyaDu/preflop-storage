import { join } from "node:path";
import { renderRoutedCommandHelp, resolveCliCommand, shouldRenderRoutedCommandHelp } from "./command-router";

const resolution = resolveCliCommand(Bun.argv.slice(2));

if (resolution.kind === "help") {
  console.log(resolution.text);
  process.exit(0);
}

if (shouldRenderRoutedCommandHelp(resolution)) {
  console.log(renderRoutedCommandHelp(resolution));
  process.exit(0);
}

if (resolution.deprecated) {
  console.warn(
    `[deprecated] ${resolution.command} --scheme ${resolution.scheme} uses legacy Scheme1. ` +
      "Use --scheme range-strata for new work.",
  );
}

const scriptPath = join(import.meta.dir, "..", "..", resolution.scriptPath);
const proc = Bun.spawn([process.execPath, scriptPath, ...resolution.forwardedArgv], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const exitCode = await proc.exited;
if (exitCode !== 0) process.exit(exitCode);
