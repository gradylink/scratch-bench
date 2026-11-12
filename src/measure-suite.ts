import { type DisplayKind, startDisplay } from "./display.ts";
import { runOnce, type RunResult } from "./measure.ts";
import type { SuiteResult } from "./report.ts";
import type { Command, Launcher, Variant } from "./runtimes/types.ts";
import { withVariant } from "./variants.ts";
import { summarize } from "./stats.ts";
import type { ProjectRun, Suite } from "./suites.ts";

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

  const stats = statsOf(runs);

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
  } else if (suite.id === "projects") {
    results = combineReplays(
      (datas as Record<string, ProjectRun>[]).flatMap((d) => Object.values(d)),
      runs.length,
      runs.find((r) => r.error)?.error,
    );
  } else if (datas.length) {
    results = datas[datas.length - 1];
  }
  return { runs, stats, results, display: displayName };
};

export const statsOf = (runs: SuiteResult["runs"]): SuiteResult["stats"] => {
  const ok = runs.filter((r) => r.ok);
  const stats: SuiteResult["stats"] = {};
  for (
    const metric of ["startup_ms", "run_ms", "wall_ms", "peak_rss_mb"] as const
  ) {
    stats[metric] = summarize(
      ok.map((r) => r[metric]!).filter((x) => x !== null),
    );
  }
  return stats;
};

/**
 * One project's replays, combined: times as medians; the checkpoints every run reached, each its
 * median (so another runtime is compared on frames all of them got through); the fewest frames and
 * the most drift. The hash is kept when every run reached the same frame and agrees, "mixed" when
 * they reached the same frame and don't (not deterministic), and dropped when they stopped at
 * different frames (not comparable). If any run failed, crashed or didn't finish, so does the
 * project: the others may not have done the same work.
 *
 * The states are kept at the checkpoints kept, as "mixed" where the runs disagree (the runtime
 * isn't deterministic there, so its state can't be checked against another's).
 *
 * A run cut in a frame that didn't end has a bound past its frames (projects/REPLAY.md), valid
 * from that frame on. When every run was cut, the result keeps one at the furthest of those frames,
 * where all of them hold, at their median; otherwise it has none.
 */
export const combineReplays = (all: ProjectRun[], runs: number, runError?: string): unknown => {
  const ran = all.filter((r) => !("error" in r)) as Extract<ProjectRun, { hash: string }>[];
  if (!ran.length || ran.length !== all.length || all.length !== runs) {
    return all.find((r) => "error" in r) ?? { error: runError ?? "no result" };
  }
  const median = (xs: number[]) => summarize(xs)!.median;
  const real = (r: (typeof ran)[number]) => Object.keys(r.checkpoints).filter((f) => Number(f) <= r.frames);
  const shared = real(ran[0]).filter((f) => ran.every((r) => real(r).includes(f)));
  const bounds = ran.map((r) => Object.keys(r.checkpoints).map(Number).filter((f) => f > r.frames).sort((x, y) => x - y)[0]);
  const bound = bounds.every((f) => f !== undefined)
    ? { [Math.max(...bounds)]: median(ran.map((r, i) => r.checkpoints[bounds[i]!])) }
    : {};
  const sameFrames = ran.every((r) => r.frames === ran[0].frames);
  return {
    recorded_frames: ran[0].recorded_frames,
    frames: Math.min(...ran.map((r) => r.frames)),
    drifted: Math.max(...ran.map((r) => r.drifted)),
    hash: !sameFrames ? null : ran.every((r) => r.hash === ran[0].hash) ? ran[0].hash : "mixed",
    checkpoints: {
      ...Object.fromEntries(shared.map((f) => [f, median(ran.map((r) => r.checkpoints[Number(f)]))])),
      ...bound,
    },
    states: Object.fromEntries(shared.map((f) => {
      const all = ran.map((r) => r.states?.[Number(f)]);
      return [f, all.every((s) => s && s === all[0]) ? all[0] : "mixed"];
    })),
    frame_ms: summarize(ran.map((r) => r.frame_ms)),
    script_ms: summarize(ran.map((r) => r.script_ms)),
    draw_ms: summarize(ran.map((r) => r.draw_ms)),
  };
};
