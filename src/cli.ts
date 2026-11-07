import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import "./cleanup.ts";
import { buildSuite, type Built } from "./build.ts";
import { type DisplayKind, startDisplay } from "./display.ts";
import { hostInfo, repoInfo } from "./hostinfo.ts";
import { measureSuite } from "./measure-suite.ts";
import { RESULTS_DIR } from "./paths.ts";
import { renderReport, type SuiteResult } from "./report.ts";
import { selectRuntimes } from "./runtimes/index.ts";
import type { Runtime, SetupInfo, Variant } from "./runtimes/types.ts";
import { summarize } from "./stats.ts";
import { selectSuites, type Suite } from "./suites.ts";
import {
  infoOf,
  labelOf,
  resultFileName,
  setupVariants,
  variantsToRun,
} from "./variants.ts";

const USAGE = `usage: bun run bench [setup] [options]

  setup                   only build the suites and set up the runtimes
  --runtime a,b           runtimes to test (default: all)
  --suite a,b             suites to run: performance, parity, projects (default: performance, parity)
                          projects replays recorded play of real projects; run \`bun run fetch-projects\` first
  --runs N                runs per runtime for the performance suite (default 10)
  --parity-runs N         runs per runtime for the parity suite (default 1)
  --project-runs N        runs per runtime for the projects suite (default 1)
  --timeout S             seconds before a run is killed (default 300)
  --display x11|wayland   virtual display backend for rendered native runs (default x11)
  --no-variants           run each runtime in its default VM mode only (not compiler and interpreter, bytecode and not)
  --offline               don't use the network; use cached runtime downloads
  --out DIR               results directory (default results/<timestamp>)
  --json                  print the results as JSON on stdout (progress goes to stderr)
`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    runtime: { type: "string" },
    suite: { type: "string" },
    runs: { type: "string" },
    "parity-runs": { type: "string" },
    "project-runs": { type: "string" },
    timeout: { type: "string", default: "300" },
    display: { type: "string", default: "x11" },
    offline: { type: "boolean", default: false },
    "no-variants": { type: "boolean", default: false },
    out: { type: "string" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}

const log = (s = "") => (opts.json ? console.error(s) : console.log(s));
const split = (s?: string) =>
  s?.split(",").map((x) => x.trim()).filter(Boolean);
const count = (s: string | undefined, fallback: number) => {
  if (s === undefined) return fallback;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`expected a positive integer, got "${s}"`);
  }
  return n;
};

const main = async (): Promise<number> => {
  const command = positionals[0] ?? "bench";
  if (!["bench", "setup"].includes(command)) {
    throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  }
  if (!["x11", "wayland"].includes(opts.display!)) {
    throw new Error('--display must be "x11" or "wayland"');
  }

  const runtimes = selectRuntimes(split(opts.runtime));
  const suites = selectSuites(split(opts.suite));
  const timeoutMs = count(opts.timeout, 300) * 1000;

  log("Building suites from source");
  const built = new Map<string, Built>();
  for (const suite of suites) {
    const b = await buildSuite(suite);
    built.set(suite.id, b);
    log(
      `  ${suite.id}: ${
        path.relative(process.cwd(), b.sb3)
      } (source ${b.hash})`,
    );
  }

  log("Setting up runtimes");
  const setups = new Map<string, SetupInfo | Error>();
  for (const rt of runtimes) {
    try {
      const info = await rt.setup({
        offline: opts.offline!,
        gui: suites.some((x) => x.launcher === "gui"),
      });
      setups.set(rt.id, info);
      log(`  ${rt.name}: ${info.version}`);
    } catch (e) {
      setups.set(rt.id, e as Error);
      log(`  ${rt.name}: setup failed: ${(e as Error).message}`);
    }
  }
  if (command === "setup") {
    return [...setups.values()].some((s) => s instanceof Error) ? 1 : 0;
  }

  const timestamp = new Date().toISOString();
  const outDir = opts.out ??
    path.join(RESULTS_DIR, timestamp.replace(/[:.]/g, "-"));
  fs.mkdirSync(outDir, { recursive: true });
  const host = hostInfo();
  const repo = repoInfo();
  const results: SuiteResult[] = [];

  for (const suite of suites) {
    for (const rt of runtimes) {
      const setup = setups.get(rt.id)!;
      for (
        const variant of variantsToRun(
          setupVariants(setup),
          !opts["no-variants"],
        )
      ) {
        const result = await runSuite(
          suite,
          rt,
          built.get(suite.id)!,
          setup,
          timeoutMs,
          variant,
        );
        const full: SuiteResult = { ...result, timestamp, host, repo };
        results.push(full);
        fs.writeFileSync(
          path.join(
            outDir,
            resultFileName(suite.id, rt.id, full.runtime.variant ?? null),
          ),
          JSON.stringify(full, null, 2) + "\n",
        );
      }
    }
  }
  fs.writeFileSync(
    path.join(outDir, "meta.json"),
    JSON.stringify(
      {
        schema_version: 1,
        timestamp,
        host,
        repo,
        command: process.argv.slice(2),
      },
      null,
      2,
    ) + "\n",
  );

  log();
  log(renderReport(results));
  log(`Results saved to ${path.relative(process.cwd(), outDir)}`);
  if (opts.json) console.log(JSON.stringify(results, null, 2));
  return results.some((r) =>
      !r.skipped && (r.error || !r.runs.some((x) => x.ok))
    )
    ? 1
    : 0;
};

const runSuite = async (
  suite: Suite,
  rt: Runtime,
  built: Built,
  setup: SetupInfo | Error,
  timeoutMs: number,
  variant: Variant | null,
): Promise<Omit<SuiteResult, "timestamp" | "host" | "repo">> => {
  const label = labelOf(rt.name, variant && infoOf(variant));
  const base = {
    schema_version: 1 as const,
    suite: { id: suite.id, source_hash: built.hash },
    runtime: {
      id: rt.id,
      name: rt.name,
      kind: rt.kind,
      version: setup instanceof Error ? "unknown" : setup.version,
      detail: setup instanceof Error ? {} : setup.detail ?? {},
      launcher: null as "headless" | "gui" | null,
      display: null as string | null,
      variant: variant ? infoOf(variant) : null,
    },
    runs: [] as SuiteResult["runs"],
    stats: {} as SuiteResult["stats"],
    results: null as unknown,
  };
  const fail = (error: string) => {
    log(`${suite.id} / ${label}: ${error}`);
    return { ...base, error };
  };
  if (setup instanceof Error) {
    return fail(`runtime setup failed: ${setup.message}`);
  }

  let kind: "headless" | "gui" = suite.launcher;
  let launcher = rt[kind];
  if (!launcher && kind === "headless" && rt.gui) {
    kind = "gui";
    launcher = rt.gui;
  }
  if (!launcher) {
    const skipped = suite.launcher === "gui"
      ? "no rendered (gui) launcher for this runtime yet"
      : `no ${suite.launcher} launcher`;
    log(`${suite.id} / ${label}: skipped, ${skipped}`);
    return { ...base, skipped };
  }
  if (suite.supports && !suite.supports(launcher.command(built.sb3, variant))) {
    const skipped = "this runtime's launcher can't run this suite yet";
    log(`${suite.id} / ${label}: skipped, ${skipped}`);
    return { ...base, skipped };
  }
  base.runtime.launcher = kind;

  const total = suite.id === "parity"
    ? count(opts["parity-runs"], suite.runs)
    : suite.id === "projects"
    ? count(opts["project-runs"], suite.runs)
    : count(opts.runs, suite.runs);
  log(
    `${suite.id} / ${label} (${kind}): ${total} run${total > 1 ? "s" : ""}`,
  );
  const measured = await measureSuite(suite, launcher, built.sb3, {
    variant,
    runs: total,
    timeoutMs: Math.max(timeoutMs, built.timeoutMs ?? 0),
    displayKind: opts.display as DisplayKind,
    log,
  });
  base.runs = measured.runs;
  base.stats = measured.stats;
  base.results = measured.results;
  base.runtime.display = measured.display;
  return base;
};

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
