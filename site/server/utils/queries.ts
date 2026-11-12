import {
  geometricMean,
  type Medians,
  SCORE_VERSION,
  PROJECT_REFERENCE,
  type ProjectScores,
  referenceFor,
  referenceRate,
  relativeSpeed,
  scoreRuntime,
  type WeightMode,
} from "../../shared/scoring.ts";
import { CATEGORY_IDS } from "../../shared/benchmarks.ts";
import type {
  History,
  HistoryRuntime,
  Latest,
  LatestRuntime,
  Meta,
  ProjectResult,
  RuntimeInfo,
  ScoreHistory,
  ScoreSeries,
  Summary,
} from "../../shared/types.ts";
import type { Dataset, Entry } from "./results.ts";

export const resolveHost = (ds: Dataset, requested?: string): string => {
  if (requested && ds.hosts.some((h) => h.id === requested)) return requested;
  return ds.hosts[0]?.id ?? "";
};

const views = new WeakMap<Dataset, { merged?: Entry[]; separate?: Entry[] }>();
export const viewOf = (ds: Dataset, separate: boolean): Entry[] => {
  const cache = views.get(ds) ?? {};
  views.set(ds, cache);
  const key = separate ? "separate" : "merged";
  if (cache[key]) return cache[key];

  let result: Entry[];
  if (!separate) {
    result = ds.entries.filter((e) =>
      !e.runtime.variant || e.runtime.variant.default
    );
  } else {
    const current = new Map<string, string>();
    for (const e of ds.entries) {
      if (e.runtime.variant?.default) {
        current.set(e.runtime.base, e.runtime.variant.id);
      }
    }
    result = ds.entries.map((e) => {
      const v = e.runtime.variant;
      if (!v) return e;
      if (current.get(e.runtime.base) === v.id) {
        return { ...e, runtime: { ...e.runtime, id: e.runtime.base } };
      }
      const id = `${e.runtime.base}~${v.id}`;
      return {
        ...e,
        runtime: { ...e.runtime, id, name: `${e.runtime.name} (${v.name})` },
      };
    });
  }
  cache[key] = result;
  return result;
};

const forHost = (ds: Dataset, host: string, separate = false) =>
  viewOf(ds, separate).filter((e) => e.hostId === host);

const hasPerformance = (e: Entry) =>
  e.suite === "performance" && e.runs.ok > 0 &&
  Object.keys(e.benchmarks).length > 0;
const hasParity = (e: Entry) =>
  e.suite === "parity" && e.runs.ok > 0 && e.parity !== null;

const hasProjects = (e: Entry) =>
  e.suite === "projects" && e.projects !== null &&
  Object.keys(e.projects).length > 0;

export const sig = (x: number | null | undefined, digits = 5): number | null =>
  typeof x === "number" && Number.isFinite(x)
    ? Number(x.toPrecision(digits))
    : null;

const rsdOf = (
  s: Summary | null | undefined,
): number | null => (s && s.mean > 0 ? s.stddev / s.mean : null);

export const buildMeta = (ds: Dataset, separate = false): Meta => {
  const latestByRuntime = new Map<string, Entry>();
  for (const e of viewOf(ds, separate)) {
    if (e.suite === "performance" || e.suite === "parity") {
      latestByRuntime.set(e.runtime.id, e);
    }
  }
  const runtimes: RuntimeInfo[] = [...latestByRuntime.values()].map((e) => ({
    id: e.runtime.id,
    base: e.runtime.base,
    variant: e.runtime.variant,
    name: e.runtime.name,
    kind: e.runtime.kind,
    version: e.runtime.version,
    launcher: e.runtime.launcher,
  }));
  return {
    runtimes,
    hasVariants: ds.entries.some((e) => e.runtime.variant !== null),
    hosts: ds.hosts,
    suites: [...new Set(ds.entries.map((e) => e.suite))].sort(),
    runCount: new Set(ds.entries.map((e) => e.runId)).size,
    latest: ds.entries.at(-1)?.timestamp ?? null,
    scoreVersion: SCORE_VERSION,
    demo: ds.demo,
    warnings: ds.warnings.slice(0, 50),
  };
};

export const buildLatest = (
  ds: Dataset,
  hostArg?: string,
  separate = false,
): Latest => {
  const host = resolveHost(ds, hostArg);
  const entries = forHost(ds, host, separate);
  const perf = entries.filter(hasPerformance);
  const par = entries.filter(hasParity);
  const latestPerf = perf.at(-1)?.timestamp ?? null;
  const latestParity = par.at(-1)?.timestamp ?? null;
  const proj = entries.filter(hasProjects);
  const latestProjects = proj.at(-1)?.timestamp ?? null;

  const ids = [...new Set(perf.map((e) => e.runtime.id))];
  const runtimes: LatestRuntime[] = ids.map((id) => {
    const p = [...perf].reverse().find((e) => e.runtime.id === id)!;
    const q = [...par].reverse().find((e) => e.runtime.id === id) ?? null;
    return {
      id,
      base: p.runtime.base,
      variant: p.runtime.variant,
      name: p.runtime.name,
      kind: p.runtime.kind,
      version: p.runtime.version,
      launcher: p.runtime.launcher,
      display: p.runtime.display,
      timestamp: p.timestamp,
      stale: p.timestamp !== latestPerf,
      suiteHash: p.suiteHash,
      repoSha: p.repoSha,
      runs: p.runs,
      benchmarks: p.benchmarks,
      startup_ms: p.startup_ms,
      run_ms: p.run_ms,
      peak_rss_mb: p.peak_rss_mb,
      parity: q?.parity
        ? {
          ...q.parity,
          timestamp: q.timestamp,
          stale: q.timestamp !== latestParity,
        }
        : null,
    };
  });
  const parityIds = [...new Set(par.map((e) => e.runtime.id))];
  const parity = parityIds.map((id) => {
    const q = [...par].reverse().find((e) => e.runtime.id === id)!;
    return {
      id,
      name: q.runtime.name,
      parity: {
        ...q.parity!,
        timestamp: q.timestamp,
        stale: q.timestamp !== latestParity,
      },
    };
  });
  const projects = [...new Set(proj.map((e) => e.runtime.id))].map((id) => {
    const q = [...proj].reverse().find((e) => e.runtime.id === id)!;
    return {
      id,
      name: q.runtime.name,
      launcher: q.runtime.launcher,
      timestamp: q.timestamp,
      stale: q.timestamp !== latestProjects,
      projects: q.projects!,
    };
  });
  return { host, timestamp: latestPerf, runtimes, parity, projects };
};

export interface HistoryQuery {
  host?: string;
  from?: string;
  to?: string;
  bench?: string[];
  rsd?: boolean;
  separate?: boolean;
}

export const buildHistory = (ds: Dataset, q: HistoryQuery = {}): History => {
  const host = resolveHost(ds, q.host);
  const entries = forHost(ds, host, q.separate).filter((e) =>
    hasPerformance(e) || hasParity(e)
  );
  const timestamps = [...new Set(entries.map((e) => e.timestamp))]
    .filter((t) => (!q.from || t >= q.from) && (!q.to || t <= q.to))
    .sort();
  const index = new Map(timestamps.map((t, i) => [t, i]));
  const want = q.bench && q.bench.length ? new Set(q.bench) : null;

  const suiteHashes: (string | null)[] = timestamps.map(() => null);
  const shas: (string | null)[] = timestamps.map(() => null);
  const runtimes: Record<string, HistoryRuntime> = {};
  const blank = () => timestamps.map(() => null as number | null);

  for (const e of entries) {
    const i = index.get(e.timestamp);
    if (i === undefined) continue;
    const r = (runtimes[e.runtime.id] ??= {
      versions: timestamps.map(() => null),
      startup_ms: blank(),
      peak_rss_mb: blank(),
      parity_passed: blank(),
      parity_total: blank(),
      backfilled: timestamps.map(() => false),
      bench: {},
      rsd: {},
    });
    r.versions[i] = e.runtime.version;
    if (e.backfilled) r.backfilled[i] = true;
    if (hasPerformance(e)) {
      suiteHashes[i] ??= e.suiteHash || null;
      shas[i] ??= e.repoSha;
      r.startup_ms[i] = sig(e.startup_ms?.median);
      r.peak_rss_mb[i] = sig(e.peak_rss_mb?.median);
      for (const [id, s] of Object.entries(e.benchmarks)) {
        if (want && !want.has(id)) continue;
        (r.bench[id] ??= blank())[i] = sig(s?.median);
        if (q.rsd) (r.rsd[id] ??= blank())[i] = sig(rsdOf(s), 3);
      }
    }
    if (hasParity(e)) {
      r.parity_passed[i] = e.parity!.passed;
      r.parity_total[i] = e.parity!.total;
    }
  }
  return { host, timestamps, suiteHashes, shas, runtimes };
};

const mediansOf = (e: Entry): Medians => {
  const m: Medians = {};
  for (const [id, s] of Object.entries(e.benchmarks)) m[id] = s?.median ?? null;
  return m;
};

export const buildScores = (
  ds: Dataset,
  q: {
    host?: string;
    weights?: WeightMode;
    from?: string;
    to?: string;
    separate?: boolean;
  } = {},
): ScoreHistory => {
  const host = resolveHost(ds, q.host);
  const weights = q.weights ?? "default";
  const entries = forHost(ds, host, q.separate);
  const perf = entries.filter(hasPerformance);
  // Each run's project scores by runtime, against that run's reference replays. A run counts as
  // having projects when the reference has a comparable replay; there, a runtime without replays
  // gets all nulls (so no total: it can't be compared with the others), and runs without (older
  // runs, results from before replays had checkpoints) keep the benchmarks' total.
  const replaysByRun = new Map<string, Record<string, Record<string, ProjectResult>>>();
  for (const e of entries.filter(hasProjects)) {
    const run = replaysByRun.get(e.runId) ?? {};
    run[e.runtime.id] = e.projects!;
    replaysByRun.set(e.runId, run);
  }
  const projectScores = new Map<string, Record<string, ProjectScores>>();
  for (const [runId, run] of replaysByRun) {
    const ids = Object.keys(run[PROJECT_REFERENCE] ?? {}).filter((id) => referenceFor(id, run));
    if (!ids.length) continue;
    const scale = geometricMean(ids.map((id) => ({ value: referenceRate(referenceFor(id, run)) ?? 0, weight: 1 })));
    if (scale === null) continue;
    const byRuntime: Record<string, ProjectScores> = {};
    for (const runtime of new Set([...Object.keys(run), ...perf.filter((e) => e.runId === runId).map((e) => e.runtime.id)])) {
      byRuntime[runtime] = {
        scale,
        speeds: Object.fromEntries(ids.map((id) => [id, relativeSpeed(run[runtime]?.[id], referenceFor(id, run))])),
      };
    }
    projectScores.set(runId, byRuntime);
  }
  const timestamps = [...new Set(perf.map((e) => e.timestamp))]
    .filter((t) => (!q.from || t >= q.from) && (!q.to || t <= q.to))
    .sort();
  const index = new Map(timestamps.map((t, i) => [t, i]));

  // Whether each run scored projects: totals from a run that did and one that didn't aren't on one
  // scale, so the site never compares them.
  const projectRuns = timestamps.map(() => false);
  for (const e of perf) {
    const i = index.get(e.timestamp);
    if (i !== undefined && projectScores.has(e.runId)) projectRuns[i] = true;
  }
  const suiteHashes: (string | null)[] = timestamps.map(() => null);
  const runtimes: Record<string, ScoreSeries> = {};
  const blank = () => timestamps.map(() => null as number | null);
  for (const e of perf) {
    const i = index.get(e.timestamp);
    if (i === undefined) continue;
    const s = (runtimes[e.runtime.id] ??= {
      total: blank(),
      coverage: blank(),
      categories: Object.fromEntries(CATEGORY_IDS.map((c) => [c, blank()])),
      projects: blank(),
    });
    suiteHashes[i] ??= e.suiteHash || null;
    const score = scoreRuntime(
      mediansOf(e),
      weights,
      projectScores.get(e.runId)?.[e.runtime.id],
    );
    s.projects[i] = sig(score.projects?.score);
    s.total[i] = sig(score.total);
    s.coverage[i] = sig(score.coverage, 3);
    for (const c of CATEGORY_IDS) {
      const series = s.categories[c];
      if (series) series[i] = sig(score.categories[c].score);
    }
  }
  return {
    host,
    weights,
    scoreVersion: SCORE_VERSION,
    timestamps,
    projectRuns,
    suiteHashes,
    runtimes,
  };
};
