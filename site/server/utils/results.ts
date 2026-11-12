import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  HostInfo,
  ParitySummary,
  ProjectResult,
  Summary,
  VariantInfo,
} from "../../shared/types.ts";

export const SUPPORTED_SCHEMA = 1;

export interface Entry {
  runId: string;
  timestamp: string;
  hostId: string;
  suite: string;
  runtime: {
    id: string;
    name: string;
    kind: string;
    version: string;
    launcher: string | null;
    display: string | null;
    base: string;
    variant: VariantInfo | null;
  };
  suiteHash: string;
  repoSha: string | null;
  runs: { ok: number; total: number };
  startup_ms: Summary | null;
  run_ms: Summary | null;
  peak_rss_mb: Summary | null;
  benchmarks: Record<string, Summary | null>;
  parity: ParitySummary | null;
  projects: Record<string, ProjectResult> | null;
  backfilled: boolean;
}

export interface Dataset {
  entries: Entry[];
  hosts: HostInfo[];
  warnings: string[];
  demo: boolean;
  signature: string;
}

const emptyDataset = (signature = "empty"): Dataset => ({
  entries: [],
  hosts: [],
  warnings: [],
  demo: false,
  signature,
});

const SAFE_NAME = /^[A-Za-z0-9._-]{1,80}$/;
const DIR_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

const isObject = (x: unknown): x is Record<string, any> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const toSummary = (x: unknown): Summary | null => {
  if (!isObject(x)) return null;
  const { n, median, mean, stddev, min, max } = x;
  const nums = [n, median, mean, stddev, min, max];
  if (!nums.every((v) => typeof v === "number" && Number.isFinite(v))) {
    return null;
  }
  return { n, median, mean, stddev, min, max };
};

const variantOf = (v: unknown): VariantInfo | null =>
  isObject(v) && typeof v.id === "string" && v.id !== ""
    ? {
      id: v.id,
      name: typeof v.name === "string" ? v.name : v.id,
      default: v.default === true,
    }
    : null;

export const hostIdOf = (host: Record<string, any>): string => {
  const key = [host.cpu, host.cores, host.memory_gb, host.os].map(String).join(
    "|",
  );
  return `h${crypto.createHash("sha1").update(key).digest("hex").slice(0, 8)}`;
};

const timestampOf = (
  json: Record<string, any>,
  runId: string,
): string | null => {
  if (
    typeof json.timestamp === "string" &&
    !Number.isNaN(Date.parse(json.timestamp))
  ) {
    return new Date(json.timestamp).toISOString();
  }
  const m = DIR_TIMESTAMP.exec(runId);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null;
};

export const parseResult = (
  json: unknown,
  runId: string,
  file: string,
): Entry | string => {
  if (!isObject(json)) return `${runId}/${file}: not a JSON object`;
  if (json.schema_version !== SUPPORTED_SCHEMA) {
    return `${runId}/${file}: unsupported schema_version ${
      String(json.schema_version)
    }`;
  }
  const { suite, runtime, host, repo } = json;
  if (!isObject(suite) || typeof suite.id !== "string") {
    return `${runId}/${file}: missing suite`;
  }
  if (!isObject(runtime) || typeof runtime.id !== "string") {
    return `${runId}/${file}: missing runtime`;
  }
  const timestamp = timestampOf(json, runId);
  if (!timestamp) return `${runId}/${file}: no valid timestamp`;

  const runs = Array.isArray(json.runs) ? json.runs : [];
  const ok = runs.filter((r: any) => isObject(r) && r.ok === true).length;
  const stats = isObject(json.stats) ? json.stats : {};
  const results = isObject(json.results) ? json.results : null;

  const benchmarks: Record<string, Summary | null> = {};
  let parity: ParitySummary | null = null;
  let projects: Record<string, ProjectResult> | null = null;
  if (suite.id === "performance" && results && ok > 0) {
    for (const [id, value] of Object.entries(results)) {
      benchmarks[id] = isObject(value) ? toSummary(value.ops_per_ms) : null;
    }
  } else if (suite.id === "projects" && results) {
    const num = (x: unknown) => typeof x === "number" && Number.isFinite(x) ? x : null;
    projects = {};
    for (const [id, value] of Object.entries(results)) {
      if (!isObject(value)) continue;
      projects[id] = {
        error: typeof value.error === "string" ? value.error : null,
        title: typeof value.title === "string" ? value.title : null,
        frame_ms: toSummary(value.frame_ms),
        script_ms: toSummary(value.script_ms),
        draw_ms: toSummary(value.draw_ms),
        wall_ms: toSummary(value.wall_ms),
        frames: num(value.frames),
        recorded_frames: num(value.recorded_frames),
        drifted: num(value.drifted),
        hash: typeof value.hash === "string" ? value.hash : null,
        hash_kind: typeof value.hash_kind === "string" ? value.hash_kind : null,
        states: isObject(value.states)
          ? Object.fromEntries(
            Object.entries(value.states).filter(([, s]) => typeof s === "string"),
          ) as Record<string, string>
          : null,
        checkpoints: isObject(value.checkpoints)
          ? Object.fromEntries(
            Object.entries(value.checkpoints).filter(([, ms]) => typeof ms === "number" && Number.isFinite(ms)),
          ) as Record<string, number>
          : null,
        ms: toSummary(value.ms),
        recorded_ms: num(value.recorded_ms),
        ticks: num(value.ticks),
        recorded_ticks: num(value.recorded_ticks),
        long_frames: num(value.long_frames),
      };
    }
  } else if (suite.id === "parity" && results && ok > 0) {
    parity = {
      verdict: results.verdict === "passed" || results.verdict === "failed"
        ? results.verdict
        : "unknown",
      passed: typeof results.passed === "number" ? results.passed : null,
      total: typeof results.total === "number" ? results.total : null,
      failed_groups: Array.isArray(results.failed_groups)
        ? results.failed_groups
          .filter((g: any) => isObject(g) && typeof g.name === "string")
          .map((g: any) => ({
            name: g.name,
            passed: Number(g.passed) || 0,
            total: Number(g.total) || 0,
            failures: Array.isArray(g.failures)
              ? g.failures.filter((f: unknown) => typeof f === "string")
              : [],
          }))
        : [],
    };
  }

  return {
    runId,
    timestamp,
    hostId: hostIdOf(isObject(host) ? host : {}),
    suite: suite.id,
    runtime: {
      id: runtime.id,
      name: typeof runtime.name === "string" ? runtime.name : runtime.id,
      kind: typeof runtime.kind === "string" ? runtime.kind : "unknown",
      version: typeof runtime.version === "string"
        ? runtime.version
        : "unknown",
      launcher: typeof runtime.launcher === "string" ? runtime.launcher : null,
      display: typeof runtime.display === "string" ? runtime.display : null,
      base: runtime.id,
      variant: variantOf(runtime.variant),
    },
    suiteHash: typeof suite.source_hash === "string" ? suite.source_hash : "",
    repoSha: isObject(repo) && typeof repo.sha === "string" ? repo.sha : null,
    runs: { ok, total: runs.length },
    startup_ms: toSummary(stats.startup_ms),
    run_ms: toSummary(stats.run_ms),
    peak_rss_mb: toSummary(stats.peak_rss_mb),
    benchmarks,
    parity,
    projects,
    backfilled: isObject(json.backfill),
  };
};

interface FileCacheItem {
  mtimeMs: number;
  size: number;
  entry: Entry | null;
  warning: string | null;
  host: Record<string, any> | null;
}
const fileCache = new Map<string, FileCacheItem>();
const datasetCache = new Map<string, Dataset>();

const statOrNull = (p: string): fs.Stats | null => {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
};

const readJson = (p: string): unknown => JSON.parse(fs.readFileSync(p, "utf8"));

export const loadDataset = (dir: string): Dataset => {
  const top = statOrNull(dir);
  if (!top?.isDirectory()) return emptyDataset();

  const runDirs = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && SAFE_NAME.test(d.name))
    .map((d) => d.name)
    .sort();

  const dirStats = runDirs.map((name) =>
    [name, statOrNull(path.join(dir, name))] as const
  );
  const signature = [
    top.mtimeMs,
    ...dirStats.map(([n, s]) => `${n}:${s?.mtimeMs ?? 0}`),
  ].join("|");
  const cached = datasetCache.get(dir);
  if (cached && cached.signature === signature) return cached;

  const entries: Entry[] = [];
  const warnings: string[] = [];
  let demo = false;
  const hostMeta = new Map<string, Record<string, any>>();

  for (const [runId] of dirStats) {
    const runPath = path.join(dir, runId);
    let files: string[];
    try {
      files = fs.readdirSync(runPath).filter((f) => f.endsWith(".json")).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      const full = path.join(runPath, file);
      const st = statOrNull(full);
      if (!st?.isFile()) continue;

      if (file === "meta.json") {
        try {
          const meta = readJson(full);
          if (isObject(meta) && meta.demo === true) demo = true;
        } catch {}
        continue;
      }

      let item = fileCache.get(full);
      if (!item || item.mtimeMs !== st.mtimeMs || item.size !== st.size) {
        let json: unknown;
        try {
          json = readJson(full);
        } catch {
          warnings.push(
            `${runId}/${file}: unreadable (incomplete or invalid JSON)`,
          );
          continue;
        }
        const parsed = parseResult(json, runId, file);
        item = {
          mtimeMs: st.mtimeMs,
          size: st.size,
          entry: typeof parsed === "string" ? null : parsed,
          warning: typeof parsed === "string" ? parsed : null,
          host: isObject(json) && isObject(json.host) ? json.host : null,
        };
        fileCache.set(full, item);
      }
      if (item.warning) warnings.push(item.warning);
      if (item.entry) {
        entries.push(item.entry);
        if (item.host && !hostMeta.has(item.entry.hostId)) {
          hostMeta.set(item.entry.hostId, item.host);
        }
      }
    }
  }

  entries.sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp) || a.suite.localeCompare(b.suite)
  );

  const hosts: HostInfo[] = [];
  for (const [id, host] of hostMeta) {
    const mine = entries.filter((e) => e.hostId === id);
    const runs = new Set(mine.map((e) => e.runId));
    hosts.push({
      id,
      label: String(host.cpu ?? "Unknown host").replace(/\s+/g, " ").trim(),
      cpu: String(host.cpu ?? "unknown"),
      cores: Number(host.cores) || 0,
      memory_gb: Number(host.memory_gb) || 0,
      os: String(host.os ?? "unknown"),
      runs: runs.size,
      first: mine[0]?.timestamp ?? "",
      last: mine.at(-1)?.timestamp ?? "",
    });
  }
  hosts.sort((a, b) => b.runs - a.runs);

  const dataset: Dataset = { entries, hosts, warnings, demo, signature };
  datasetCache.set(dir, dataset);
  return dataset;
};
