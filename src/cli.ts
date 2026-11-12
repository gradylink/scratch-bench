import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import "./cleanup.ts";
import { buildSuite, type Built } from "./build.ts";
import { type DisplayKind, startDisplay } from "./display.ts";
import { hostInfo, repoInfo } from "./hostinfo.ts";
import { combineReplays, measureSuite, statsOf } from "./measure-suite.ts";
import { RESULTS_DIR } from "./paths.ts";
import { renderReport, type SuiteResult } from "./report.ts";
import { selectRuntimes } from "./runtimes/index.ts";
import type { Runtime, SetupInfo, Variant } from "./runtimes/types.ts";
import { summarize } from "./stats.ts";
import { type ProjectRun, selectSuites, type Suite } from "./suites.ts";
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
  --suite a,b             suites to run: performance, parity, projects (default: all)
  --runs N                runs per runtime for the performance suite (default 10)
  --parity-runs N         runs per runtime for the parity suite (default 1)
  --project-runs N        runs of each project for the projects suite (default 3; the medians count)
  --timeout S             seconds before a run is killed (default 300; for the projects suite, each
                          project's budget plus 140 s)
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
    timeout: { type: "string" },
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
  // A suite that can't be built (projects that couldn't be downloaded, say) fails on its own.
  const built = new Map<string, Built | Error>();
  for (const suite of suites) {
    try {
      const b = await buildSuite(suite, {
        offline: opts.offline,
          log,
      });
      built.set(suite.id, b);
      log(
        `  ${suite.id}: ${
          path.relative(process.cwd(), b.sb3)
        } (source ${b.hash})`,
      );
    } catch (e) {
      built.set(suite.id, e as Error);
      log(`  ${suite.id}: build failed: ${(e as Error).message}`);
    }
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
    return [...setups.values(), ...built.values()].some((s) => s instanceof Error) ? 1 : 0;
  }

  const timestamp = new Date().toISOString();
  const outDir = opts.out ??
    path.join(RESULTS_DIR, timestamp.replace(/[:.]/g, "-"));
  fs.mkdirSync(outDir, { recursive: true });
  const host = hostInfo();
  const repo = repoInfo();
  const results: SuiteResult[] = [];

  const save = (full: SuiteResult) =>
    fs.writeFileSync(
      path.join(outDir, resultFileName(full.suite.id, full.runtime.id, full.runtime.variant ?? null)),
      JSON.stringify(full, null, 2) + "\n",
    );
  for (const suite of suites) {
    const b = built.get(suite.id)!;
    if (suite.id === "projects" && !(b instanceof Error) && b.projects) {
      const done = await runProjects(suite, runtimes, b, setups, timeoutMs, (result) => save({ ...result, timestamp, host, repo }));
      results.push(...done.map((r) => ({ ...r, timestamp, host, repo })));
      continue;
    }
    for (const rt of runtimes) {
      const setup = setups.get(rt.id)!;
      for (
        const variant of variantsToRun(
          setupVariants(setup),
          !opts["no-variants"] && !suite.defaultVariantOnly,
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

type Result = Omit<SuiteResult, "timestamp" | "host" | "repo">;

/**
 * The projects suite. Every runtime replays every project once a round, the runtimes in turn for
 * each project (in an order that moves along a place each project and each round), for as many
 * rounds as runs:
 * whatever else the machine is doing then falls on all of them about alike, rather than on
 * whichever runtime's turn it was, and on the reference above all. Each runtime's results are
 * written after every round, so a run stopped early keeps the rounds it finished.
 */
const runProjects = async (
  suite: Suite,
  runtimes: Runtime[],
  built: Built,
  setups: Map<string, SetupInfo | Error>,
  timeoutMs: number,
  save: (result: Result) => void,
): Promise<Result[]> => {
  const projects = built.projects!;
  const done: Result[] = [];
  const plans: (Prepared & { replays: Record<string, ProjectRun[]>; errors: Record<string, string> })[] = [];
  for (const rt of runtimes) {
    const setup = setups.get(rt.id)!;
    for (const variant of variantsToRun(setupVariants(setup), false)) {
      const prepared = prepare(suite, rt, built, setup, timeoutMs, variant);
      if ("result" in prepared) {
        save(prepared.result);
        done.push(prepared.result);
      } else {
        plans.push({ ...prepared, replays: {}, errors: {} });
      }
    }
  }
  const rounds = Math.max(0, ...plans.map((p) => p.options.runs));
  const resultsOf = (plan: (typeof plans)[number], round: number) =>
    Object.fromEntries(projects.map((p) => [p.id, {
      title: p.title,
      // Every runner hashes the state the same way (projects/REPLAY.md, "State").
      hash_kind: "state",
      recorded_frames: p.frames,
      ...(combineReplays(plan.replays[p.id] ?? [], round, plan.errors[p.id]) as object),
    }]));
  for (let round = 1; round <= rounds; round++) {
    for (const [n, p] of projects.entries()) {
      log(`projects round ${round}/${rounds}: ${p.id} ${p.title}`);
      const shift = (round - 1 + n) % plans.length;
      const order = [...plans.slice(shift), ...plans.slice(0, shift)];
      for (const plan of order) {
        const replay = { recording: p.recording, id: p.id, budgetMs: p.durationMs };
        const replaying = {
          ...plan.launcher,
          command: (sb3: string, v?: Variant | null) => plan.launcher.replay!(sb3, replay, v),
        };
        const measured = await measureSuite(suite, replaying, p.sb3, {
          ...plan.options,
          runs: 1,
          log: (line) => log(`  ${plan.label}: ${line.trim().replace(/^run 1\/1: /, "")}`),
        });
        plan.base.runs.push(...measured.runs);
        plan.base.runtime.display = measured.display;
        const run = measured.runs[0];
        const data = run?.data as Record<string, ProjectRun> | undefined;
        (plan.replays[p.id] ??= []).push(...Object.values(data ?? {}));
        if (!run?.ok) plan.errors[p.id] ??= run?.error ?? "no result";
      }
    }
    for (const plan of plans) {
      plan.base.stats = statsOf(plan.base.runs);
      plan.base.results = resultsOf(plan, round);
      save(plan.base);
    }
  }
  // In the runtimes' order, as the other suites report them.
  const order = (r: Result) => runtimes.findIndex((rt) => rt.id === r.runtime.id);
  return [...done, ...plans.map((p) => p.base)].sort((a, b) => order(a) - order(b));
};

type Prepared = {
  base: Result;
  launcher: NonNullable<Runtime["gui"]>;
  label: string;
  options: Parameters<typeof measureSuite>[3];
};

/** Which of a runtime's launchers runs a suite, and how; or its result, if it can't. */
const prepare = (
  suite: Suite,
  rt: Runtime,
  built: Built | Error,
  setup: SetupInfo | Error,
  timeoutMs: number,
  variant: Variant | null,
): Prepared | { result: Result } => {
  const label = labelOf(rt.name, variant && infoOf(variant));
  const base = {
    schema_version: 1 as const,
    suite: { id: suite.id, source_hash: built instanceof Error ? "unknown" : built.hash },
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
    return { result: { ...base, error } };
  };
  if (built instanceof Error) {
    return fail(`suite build failed: ${built.message}`);
  }
  if (setup instanceof Error) {
    return fail(`runtime setup failed: ${setup.message}`);
  }

  let kind: "headless" | "gui" = suite.launcher;
  let launcher = rt[kind];
  if (!launcher && kind === "headless" && rt.gui) {
    kind = "gui";
    launcher = rt.gui;
  }
  // Replays go to whichever launcher can do them (a native runtime's is headless).
  if (suite.id === "projects" && !launcher?.replay && rt.headless?.replay) {
    kind = "headless";
    launcher = rt.headless;
  }
  if (!launcher) {
    const skipped = suite.launcher === "gui"
      ? "no rendered (gui) launcher for this runtime yet"
      : `no ${suite.launcher} launcher`;
    log(`${suite.id} / ${label}: skipped, ${skipped}`);
    return { result: { ...base, skipped } };
  }
  if (suite.id === "projects" && !launcher.replay) {
    const skipped = "can't replay recordings yet (projects/REPLAY.md)";
    log(`${suite.id} / ${label}: skipped, ${skipped}`);
    return { result: { ...base, skipped } };
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
  const options = {
    variant,
    runs: total,
    timeoutMs: opts.timeout === undefined ? built.timeoutMs ?? timeoutMs : timeoutMs,
    displayKind: opts.display as DisplayKind,
    log,
  };
  return { base, launcher, label, options };
};

const runSuite = async (
  suite: Suite,
  rt: Runtime,
  built: Built | Error,
  setup: SetupInfo | Error,
  timeoutMs: number,
  variant: Variant | null,
): Promise<Result> => {
  const prepared = prepare(suite, rt, built, setup, timeoutMs, variant);
  if ("result" in prepared) return prepared.result;
  const { base, launcher, options } = prepared;
  const measured = await measureSuite(suite, launcher, (built as Built).sb3, options);
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
