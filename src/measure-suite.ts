import { type DisplayKind, startDisplay } from "./display.ts";
import { runOnce, type RunResult } from "./measure.ts";
import type { SuiteResult } from "./report.ts";
import type { Command, Launcher, Variant } from "./runtimes/types.ts";
import { withVariant } from "./variants.ts";
import { summarize } from "./stats.ts";
import type { Suite } from "./suites.ts";

export interface MeasureOptions {
  runs: number;
  timeoutMs: number;
  displayKind: DisplayKind;
  variant?: Variant | null;
  log?: (line: string) => void;
}

export interface Measured {
  runs: SuiteResult["runs"];
  stats: SuiteResult["stats"];
  results: unknown;
  display: string | null;
}

export type LaunchLike = Pick<Launcher, "display"> & {
  command(sb3: string, variant?: Variant | null): Command;
};

export const measureSuite = async (
  suite: Suite,
  launcher: LaunchLike,
  sb3: string,
  o: MeasureOptions,
): Promise<Measured> => {
  const log = o.log ?? (() => {});
  const runs: SuiteResult["runs"] = [];
  const datas: unknown[] = [];
  let displayName: string | null = null;
  o.variant?.prepare?.(sb3);

  for (let i = 1; i <= o.runs; i++) {
    let run: RunResult;
    let display = null;
    try {
      let command = withVariant(launcher.command(sb3, o.variant), o.variant);
      if (launcher.display) {
        display = await startDisplay(o.displayKind);
        displayName = display.backend;
        command = display.wrap(command);
      }
      run = await runOnce(command, suite, o.timeoutMs);
    } catch (e) {
      run = {
        ok: false,
        error: (e as Error).message,
        startup_ms: null,
        run_ms: null,
        wall_ms: null,
        peak_rss_mb: null,
        lines: [],
        exit_code: null,
      };
    } finally {
      await display?.stop();
    }
    const data = run.ok ? suite.parse(run.lines) : undefined;
    if (data !== undefined) datas.push(data);
    runs.push({
      ok: run.ok,
      error: run.error,
      startup_ms: run.startup_ms,
      run_ms: run.run_ms,
      wall_ms: run.wall_ms,
      peak_rss_mb: run.peak_rss_mb,
      data,
      tail: run.ok ? undefined : run.lines.slice(-30),
    });
    log(
      run.ok
        ? `  run ${i}/${o.runs}: startup ${run.startup_ms} ms, run ${run.run_ms} ms, peak ${run.peak_rss_mb} MB`
        : `  run ${i}/${o.runs}: FAILED ${run.error}`,
    );
  }

  const ok = runs.filter((r) => r.ok);
  const stats: SuiteResult["stats"] = {};
  for (
    const metric of ["startup_ms", "run_ms", "wall_ms", "peak_rss_mb"] as const
  ) {
    stats[metric] = summarize(
      ok.map((r) => r[metric]!).filter((x) => x !== null),
    );
  }

  let results: unknown = null;
  if (suite.id === "performance") {
    const perRun = datas as Record<
      string,
      { ops_per_ms: number; total_ms: number }
    >[];
    const ids = [...new Set(perRun.flatMap((d) => Object.keys(d)))];
    results = Object.fromEntries(
      ids.map((id) => [
        id,
        {
          ops_per_ms: summarize(
            perRun.map((d) => d[id]?.ops_per_ms).filter((x) => x !== undefined),
          ),
          total_ms: summarize(
            perRun.map((d) => d[id]?.total_ms).filter((x) => x !== undefined),
          ),
        },
      ]),
    );
  } else if (datas.length) {
    results = datas[datas.length - 1];
  }
  return { runs, stats, results, display: displayName };
};
