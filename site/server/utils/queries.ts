import {
  type Medians,
  SCORE_VERSION,
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
    if (e.suite === "performance" || e.suite === "parity") latestByRuntime.set(e.runtime.id, e);
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
  return { host, timestamp: latestPerf, runtimes, parity };
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
  const perf = forHost(ds, host, q.separate).filter(hasPerformance);
  const timestamps = [...new Set(perf.map((e) => e.timestamp))]
    .filter((t) => (!q.from || t >= q.from) && (!q.to || t <= q.to))
    .sort();
  const index = new Map(timestamps.map((t, i) => [t, i]));

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
    });
    suiteHashes[i] ??= e.suiteHash || null;
    const score = scoreRuntime(mediansOf(e), weights);
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
    suiteHashes,
    runtimes,
  };
};
