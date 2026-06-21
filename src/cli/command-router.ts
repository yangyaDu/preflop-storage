export type CliCommand =
  | "build"
  | "query"
  | "verify"
  | "benchmark"
  | "benchmark-cold"
  | "benchmark-compare"
  | "analyze-sqlite"
  | "analyze-binary";

export type CliScheme = "range-strata" | "scheme1" | "sqlite";

export interface CliRunResolution {
  kind: "run";
  command: CliCommand;
  scheme: CliScheme;
  scriptPath: string;
  forwardedArgv: string[];
  deprecated: boolean;
}

export interface CliHelpResolution {
  kind: "help";
  text: string;
}

export type CliResolution = CliRunResolution | CliHelpResolution;

const RANGE_STRATA_SCHEMES = new Set(["range-strata", "range-strata-binary", "rsb", "binary"]);
const SCHEME1_SCHEMES = new Set(["scheme1", "legacy"]);

export function resolveCliCommand(argv: string[]): CliResolution {
  if (argv.length === 0 || isTopLevelHelp(argv)) {
    return { kind: "help", text: renderUnifiedCliHelp() };
  }

  const command = parseCommand(argv[0]);
  if (!command) {
    throw new Error(`Unknown command: ${argv[0]}\n\n${renderUnifiedCliHelp()}`);
  }

  const { scheme, argv: forwardedArgv } = extractScheme(argv.slice(1));
  return resolveCommand(command, scheme, forwardedArgv);
}

export function renderUnifiedCliHelp(): string {
  return `Usage: bun run <script> <command> [--scheme <name>] [options]

Commands:
  build               Build Range Strata Binary output by default
  query               Query Range Strata Binary output by default
  verify              Verify Range Strata Binary output by default
  benchmark           Benchmark Range Strata Binary by default
  benchmark-cold      Run Range Strata Binary cold-start benchmark
  benchmark-compare   Compare SQLite and binary benchmark reports
  analyze-sqlite      Analyze source SQLite storage
  analyze-binary      Analyze deprecated Scheme1 binary storage

Scheme selection:
  --scheme range-strata   Current default for build/query/verify/benchmark
  --scheme scheme1        Deprecated Scheme1 compatibility path where available
  --scheme sqlite         SQLite baseline, only for benchmark

Examples:
  bun run cli build --source range-db/range.db --out range-db/range-strata-binary
  bun run cli query --player-count 6 --depth-bb 100 --concrete-line-id 1 --hand AA
  bun run cli benchmark --scheme sqlite --iterations 1000
  bun run cli verify --scheme scheme1 --dir range-db/binary --mode sample`;
}

export function shouldRenderRoutedCommandHelp(resolution: CliRunResolution): boolean {
  if (!hasHelpFlag(resolution.forwardedArgv)) return false;

  // The current build/query/verify entrypoints already own detailed help text.
  return !(resolution.scheme === "range-strata" && ["build", "query", "verify"].includes(resolution.command));
}

export function renderRoutedCommandHelp(resolution: CliRunResolution): string {
  switch (resolution.command) {
    case "build":
      return `Usage: bun run cli build --scheme ${resolution.scheme} [options]

Options:
  --source <path>       Source SQLite DB path (default: range-db/range.db)
  --out <path>          Output directory
  --overwrite           Rebuild from scratch
  --dimension <spec>    Build only one dimension; repeatable
  --max-packs <n>       Limit packs per dimension for smoke tests
  --help, --h           Show this help`;
    case "query":
      return `Usage: bun run cli query --scheme ${resolution.scheme} --player-count <n> --depth-bb <bb> --concrete-line-id <id> --hand <code> [options]

Options:
  --dir <path>              Binary output directory
  --meta <path>             meta.db path
  --strategy <name>         Strategy name (default: default)
  --player-count <n>        Player count
  --depth-bb <bb>           Stack depth in BB
  --concrete-line-id <id>   Concrete line id
  --hand <code>             Hand code such as AA, AKs, AKo
  --verify-checksum         Verify pack CRC32C before decoding
  --help, --h               Show this help`;
    case "verify":
      return `Usage: bun run cli verify --scheme ${resolution.scheme} [options]

Options:
  --source <path>       Source SQLite DB path (default: range-db/range.db)
  --dir <path>          Binary output directory
  --meta <path>         meta.db path
  --mode <sample|full>  Scheme1 verify mode (default: sample)
  --sample-size <n>     Sample size for sample mode
  --max-failures <n>    Maximum stored failures
  --dimension <spec>    Verify only one dimension; repeatable
  --out <path>          JSON report path
  --md <path>           Markdown report path
  --help, --h           Show this help`;
    case "benchmark":
      return renderBenchmarkHelp(resolution.scheme);
    case "benchmark-cold":
      return `Usage: bun run cli benchmark-cold [options]

Options:
  --source <path>                  Source SQLite DB path (default: range-db/range.db)
  --dir <path>                     Range Strata Binary output directory
  --runs <n>                       Alias for --runs-per-dimension
  --runs-per-dimension <n>         Runs per dimension
  --dimension <spec>               Benchmark only one dimension; repeatable
  --query-policy <first|fixed>     Query selection policy
  --concrete-line-id <id>          Required with --query-policy fixed
  --hand <code>                    Required with --query-policy fixed
  --mode <process-cold|os-best-effort|linux-drop-cache>
  --fail-fast                      Stop on first worker failure
  --out <path>                     JSON report path
  --md <path>                      Markdown report path
  --help, --h                      Show this help`;
    case "benchmark-compare":
      return `Usage: bun run cli benchmark-compare [options]

Options:
  --sqlite <path>      SQLite benchmark JSON (default: reports/benchmark-sqlite.json)
  --binary <path>      Binary benchmark JSON (default: reports/benchmark-range-strata-binary.json)
  --out <path>         JSON report path
  --md <path>          Markdown report path
  --help, --h          Show this help`;
    case "analyze-sqlite":
      return `Usage: bun run cli analyze-sqlite [options]

Options:
  --source <path>      Source SQLite DB path (default: range-db/range.db)
  --out <path>         JSON report path
  --md <path>          Markdown report path
  --help, --h          Show this help`;
    case "analyze-binary":
      return `Usage: bun run cli analyze-binary [options]

Options:
  --dir <path>             Scheme1 binary output directory (default: range-db/binary)
  --meta <path>            meta.db path
  --sqlite-report <path>   SQLite analysis JSON path
  --out <path>             JSON report path
  --md <path>              Markdown report path
  --help, --h              Show this help`;
  }
}

function resolveCommand(command: CliCommand, scheme: string | null, forwardedArgv: string[]): CliRunResolution {
  switch (command) {
    case "build": {
      const selected = normalizeBuildQueryVerifyScheme(command, scheme);
      return selected === "scheme1"
        ? legacy(command, selected, "src/scheme1/cli/build-binary.ts", forwardedArgv)
        : current(command, selected, "src/range-strata-binary/cli/compile.ts", forwardedArgv);
    }
    case "query": {
      const selected = normalizeBuildQueryVerifyScheme(command, scheme);
      return selected === "scheme1"
        ? legacy(command, selected, "src/scheme1/cli/query-hand.ts", forwardedArgv)
        : current(command, selected, "src/range-strata-binary/cli/query.ts", forwardedArgv);
    }
    case "verify": {
      const selected = normalizeBuildQueryVerifyScheme(command, scheme);
      return selected === "scheme1"
        ? legacy(command, selected, "src/scheme1/cli/verify-binary.ts", forwardedArgv)
        : current(command, selected, "src/range-strata-binary/cli/verify.ts", forwardedArgv);
    }
    case "benchmark": {
      const selected = normalizeBenchmarkScheme(scheme);
      if (selected === "scheme1") {
        return legacy(command, selected, "src/scheme1/cli/benchmark-binary.ts", forwardedArgv);
      }
      if (selected === "sqlite") {
        return current(command, selected, "src/scheme1/cli/benchmark-sqlite.ts", forwardedArgv);
      }
      return current(command, selected, "src/range-strata-binary/cli/benchmark.ts", forwardedArgv);
    }
    case "benchmark-cold":
      assertRangeOnly(command, scheme);
      return current(command, "range-strata", "src/range-strata-binary/cli/cold-benchmark.ts", forwardedArgv);
    case "benchmark-compare":
      assertNoScheme(command, scheme);
      return current(command, "scheme1", "src/scheme1/cli/benchmark-compare.ts", forwardedArgv);
    case "analyze-sqlite":
      assertNoScheme(command, scheme);
      return current(command, "sqlite", "src/scheme1/cli/analyze-sqlite.ts", forwardedArgv);
    case "analyze-binary":
      assertNoScheme(command, scheme);
      return legacy(command, "scheme1", "src/scheme1/cli/analyze-binary.ts", forwardedArgv);
  }
}

function parseCommand(value: string): CliCommand | null {
  if (value === "cold-benchmark") return "benchmark-cold";
  if (value === "compare") return "benchmark-compare";

  const commands: CliCommand[] = [
    "build",
    "query",
    "verify",
    "benchmark",
    "benchmark-cold",
    "benchmark-compare",
    "analyze-sqlite",
    "analyze-binary",
  ];
  return commands.includes(value as CliCommand) ? (value as CliCommand) : null;
}

function extractScheme(argv: string[]): { scheme: string | null; argv: string[] } {
  let scheme: string | null = null;
  const forwarded: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token !== "--scheme") {
      forwarded.push(token);
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("--scheme requires a value");
    }
    scheme = value;
    index += 1;
  }

  return { scheme, argv: forwarded };
}

function normalizeBuildQueryVerifyScheme(command: CliCommand, scheme: string | null): "range-strata" | "scheme1" {
  if (!scheme) return "range-strata";
  if (RANGE_STRATA_SCHEMES.has(scheme)) return "range-strata";
  if (SCHEME1_SCHEMES.has(scheme)) return "scheme1";
  throw new Error(`Unsupported --scheme for ${command}: ${scheme}. Use range-strata or scheme1.`);
}

function normalizeBenchmarkScheme(scheme: string | null): CliScheme {
  if (!scheme) return "range-strata";
  if (RANGE_STRATA_SCHEMES.has(scheme)) return "range-strata";
  if (SCHEME1_SCHEMES.has(scheme)) return "scheme1";
  if (scheme === "sqlite") return "sqlite";
  throw new Error(`Unsupported --scheme for benchmark: ${scheme}. Use range-strata, scheme1, or sqlite.`);
}

function assertRangeOnly(command: CliCommand, scheme: string | null): void {
  if (!scheme || RANGE_STRATA_SCHEMES.has(scheme)) return;
  throw new Error(`Unsupported --scheme for ${command}: ${scheme}. This command only supports range-strata.`);
}

function assertNoScheme(command: CliCommand, scheme: string | null): void {
  if (!scheme) return;
  throw new Error(`--scheme is not supported for ${command}`);
}

function current(command: CliCommand, scheme: CliScheme, scriptPath: string, forwardedArgv: string[]): CliRunResolution {
  return { kind: "run", command, scheme, scriptPath, forwardedArgv, deprecated: false };
}

function legacy(command: CliCommand, scheme: CliScheme, scriptPath: string, forwardedArgv: string[]): CliRunResolution {
  return { kind: "run", command, scheme, scriptPath, forwardedArgv, deprecated: true };
}

function isTopLevelHelp(argv: string[]): boolean {
  return argv.length === 1 && (argv[0] === "--help" || argv[0] === "--h" || argv[0] === "-h");
}

function hasHelpFlag(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("--h") || argv.includes("-h");
}

function renderBenchmarkHelp(scheme: CliScheme): string {
  const binaryPathOptions =
    scheme === "sqlite"
      ? ""
      : `
  --dir <path>              Binary output directory
  --meta <path>             meta.db path`;
  const rangeOnlyOptions =
    scheme === "range-strata"
      ? `
  --prewarm-action-schemas  Preload action schemas before hot measurements
  --evict-os-cache          Best-effort OS cache perturbation before cold measurement`
      : "";
  const scheme1OnlyOptions =
    scheme === "scheme1"
      ? `
  --pack-cache-size <n>     Scheme1 decoded pack cache size`
      : "";
  const checksumOption =
    scheme === "sqlite"
      ? ""
      : `
  --verify-checksum         Verify pack CRC32C before decoding`;
  const verifyResultsOption =
    scheme === "sqlite"
      ? ""
      : `
  --verify-results          Compare a sample of benchmark results with source SQLite`;

  return `Usage: bun run cli benchmark --scheme ${scheme} [options]

Options:
  --source <path>           Source SQLite DB path (default: range-db/range.db)
${binaryPathOptions}
  --out <path>              JSON report path
  --md <path>               Markdown report path
  --workload <path>         Load benchmark workload JSON
  --dimension <spec>        Benchmark only one dimension; repeatable
  --seed <n>                Workload random seed
  --iterations <n>          Default iteration count
  --hand-iterations <n>     Hand-query iteration count
  --batch-iterations <n>    Batch-query iteration count
  --batch-size <n>          Primary batch size
  --batch-sizes <list>      Comma-separated batch sizes
  --warmup-iterations <n>   Warmup iterations
  --workload-mode <mode>    Workload mode for generated workloads${verifyResultsOption}${checksumOption}${rangeOnlyOptions}${scheme1OnlyOptions}
  --help, --h               Show this help`;
}
