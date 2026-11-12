import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generate } from "../scripts/demo-results.ts";
import { BENCHMARKS, CATEGORY_IDS } from "../shared/benchmarks.ts";
import { SCORE_VERSION } from "../shared/scoring.ts";
import {
  buildHistory,
  buildLatest,
  buildMeta,
  buildScores,
  resolveHost,
} from "../server/utils/queries.ts";
import { loadDataset, parseResult } from "../server/utils/results.ts";

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-site-"));
  generate(dir, { nights: 14, end: new Date("2026-09-30T00:00:00Z"), seed: 7 });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("backfilled results", () => {
  it("are flagged in the dataset and in the history", () => {
    const run = path.join(dir, "2098-01-01T03-00-00-000Z");
    fs.mkdirSync(run);
    const src = JSON.parse(
      fs.readFileSync(
        path.join(
          dir,
          fs.readdirSync(dir).sort()[0],
          "performance-scratch.json",
        ),
        "utf8",
      ),
    );
    fs.writeFileSync(
      path.join(run, "performance-scratch.json"),
      JSON.stringify({
        ...src,
        timestamp: "2098-01-01T03:00:00.000Z",
        backfill: { date: "2098-01-01" },
      }),
    );
    const ds = loadDataset(dir);
    const flagged = ds.entries.filter((e) => e.backfilled);
    expect(flagged.length).toBe(1);
    expect(ds.entries.length - flagged.length).toBeGreaterThan(14);
    const h = buildHistory(ds, { host: flagged[0].hostId });
    const i = h.timestamps.indexOf("2098-01-01T03:00:00.000Z");
    expect(h.runtimes.scratch.backfilled[i]).toBe(true);
    expect(h.runtimes.scratch.backfilled[0]).toBe(false);
    fs.rmSync(run, { recursive: true });
  });
});

describe("loadDataset", () => {
  it("loads every run, recognises the demo flag and groups two hosts", () => {
    const ds = loadDataset(dir);
    expect(ds.entries.length).toBeGreaterThan(14 * 6);
    expect(ds.demo).toBe(true);
    expect(ds.hosts.length).toBe(2);
    expect(ds.hosts[0].runs).toBeGreaterThan(ds.hosts[1].runs);
    expect(ds.warnings).toEqual([]);
    const ts = ds.entries.map((e) => e.timestamp);
    expect([...ts].sort()).toEqual(ts);
  });

  it("returns the same dataset until the directory changes", () => {
    const a = loadDataset(dir);
    expect(loadDataset(dir)).toBe(a);
    const run = path.join(dir, "2099-01-01T00-00-00-000Z");
    fs.mkdirSync(run);
    fs.copyFileSync(
      path.join(dir, fs.readdirSync(dir).sort()[0], "performance-scratch.json"),
      path.join(run, "performance-scratch.json"),
    );
    const b = loadDataset(dir);
    expect(b).not.toBe(a);
    expect(b.entries.length).toBe(a.entries.length + 1);
    fs.rmSync(run, { recursive: true });
  });

  it("returns an empty dataset for a missing directory", () => {
    const ds = loadDataset(path.join(dir, "nope"));
    expect(ds.entries).toEqual([]);
    expect(buildMeta(ds).latest).toBeNull();
    expect(buildLatest(ds).runtimes).toEqual([]);
    expect(buildHistory(ds).timestamps).toEqual([]);
  });

  it("skips bad files with a warning instead of failing", () => {
    const bad = fs.mkdtempSync(path.join(os.tmpdir(), "bench-bad-"));
    const run = path.join(bad, "2026-01-01T00-00-00-000Z");
    fs.mkdirSync(run);
    fs.writeFileSync(
      path.join(run, "performance-a.json"),
      '{"schema_version": 1, "su',
    );
    fs.writeFileSync(
      path.join(run, "performance-b.json"),
      JSON.stringify({ schema_version: 99 }),
    );
    fs.writeFileSync(
      path.join(run, "performance-c.json"),
      JSON.stringify({ schema_version: 1, suite: { id: "performance" } }),
    );
    fs.writeFileSync(path.join(run, "notes.json"), "[]");
    fs.mkdirSync(path.join(bad, "not a safe name"));
    const ds = loadDataset(bad);
    expect(ds.entries).toEqual([]);
    expect(ds.warnings.length).toBe(4);
    expect(ds.warnings.join("\n")).toMatch(/unsupported schema_version 99/);
    fs.rmSync(bad, { recursive: true, force: true });
  });
});

describe("parseResult", () => {
  it("treats a performance file with no successful runs as having no benchmarks", () => {
    const e = parseResult(
      {
        schema_version: 1,
        timestamp: "2026-01-01T00:00:00Z",
        suite: { id: "performance", source_hash: "x" },
        runtime: { id: "r", name: "R" },
        host: {},
        runs: [{ ok: false }],
        stats: {},
        results: {
          loops_empty: {
            ops_per_ms: { n: 1, median: 5, mean: 5, stddev: 0, min: 5, max: 5 },
          },
        },
      },
      "run",
      "f.json",
    );
    expect(typeof e).not.toBe("string");
    expect((e as any).runs).toEqual({ ok: 0, total: 1 });
    expect((e as any).benchmarks).toEqual({});
  });
  it("ignores malformed summaries", () => {
    const e = parseResult(
      {
        schema_version: 1,
        timestamp: "2026-01-01T00:00:00Z",
        suite: { id: "performance" },
        runtime: { id: "r" },
        host: {},
        runs: [{ ok: true }],
        stats: {},
        results: { loops_empty: { ops_per_ms: { median: "fast" } } },
      },
      "run",
      "f.json",
    ) as any;
    expect(e.benchmarks.loops_empty).toBeNull();
  });
});

describe("queries", () => {
  const ds = () => loadDataset(dir);

  it("meta lists runtimes, hosts and the latest timestamp", () => {
    const m = buildMeta(ds());
    expect(m.runtimes.map((r) => r.id).sort()).toEqual([
      "mistwarp",
      "nitrobolt",
      "penguinmod",
      "scratch",
      "scratch-everywhere",
      "turbowarp",
    ]);
    expect(m.suites).toEqual(["parity", "performance"]);
    expect(m.scoreVersion).toBe(SCORE_VERSION);
    expect(m.latest).toMatch(/^2026-09-30/);
  });

  it("falls back to the busiest host for an unknown host", () => {
    const d = ds();
    expect(resolveHost(d, "h-nope")).toBe(d.hosts[0].id);
    expect(resolveHost(d, d.hosts[1].id)).toBe(d.hosts[1].id);
  });

  it("latest has every benchmark per runtime and a parity summary", () => {
    const l = buildLatest(ds());
    const scratch = l.runtimes.find((r) => r.id === "scratch")!;
    expect(Object.keys(scratch.benchmarks).sort()).toEqual(
      BENCHMARKS.map((b) => b.id).sort(),
    );
    expect(scratch.parity?.total).toBe(2123);
    const pm = l.runtimes.find((r) => r.id === "penguinmod");
    if (pm) expect(pm.parity?.total).toBe(2123);
  });

  it("history is aligned to one timestamp axis, and bench filtering works", () => {
    const h = buildHistory(ds(), { bench: ["app_life", "loops_empty"] });
    const n = h.timestamps.length;
    expect(n).toBeGreaterThan(5);
    expect(h.suiteHashes.length).toBe(n);
    for (const r of Object.values(h.runtimes)) {
      expect(Object.keys(r.bench).sort()).toEqual(["app_life", "loops_empty"]);
      expect(r.bench.app_life.length).toBe(n);
      expect(r.versions.length).toBe(n);
    }
    const full = buildHistory(ds());
    expect(new Set(full.suiteHashes.filter(Boolean)).size)
      .toBeGreaterThanOrEqual(1);
  });

  it("history can be limited to a time range", () => {
    const all = buildHistory(ds());
    const mid = all.timestamps[Math.floor(all.timestamps.length / 2)];
    const later = buildHistory(ds(), { from: mid });
    expect(later.timestamps[0] >= mid).toBe(true);
    expect(later.timestamps.length).toBeLessThan(all.timestamps.length);
  });

  it("scores each runtime from its own results, so faster runtimes score higher", () => {
    const s = buildScores(ds());
    const last = (id: string) =>
      s.runtimes[id].total.filter((x) => x !== null).at(-1)!;
    expect(last("turbowarp")).toBeGreaterThan(last("scratch") * 20);
    expect(last("scratch-everywhere")).toBeGreaterThan(last("scratch"));
    expect(last("scratch")).toBeGreaterThan(1);
    expect(s.suiteHashes.length).toBe(s.timestamps.length);
    for (const c of CATEGORY_IDS) {
      expect(s.runtimes.scratch.categories[c].filter((x) => x !== null).at(-1))
        .toBeGreaterThan(0);
    }
  });

  it("equal weights change the score", () => {
    const d = ds();
    const eq = buildScores(d, { weights: "equal" });
    const def = buildScores(d, { weights: "default" });
    expect(eq.weights).toBe("equal");
    const a = eq.runtimes.turbowarp.total.filter((x) => x !== null).at(-1)!;
    const b = def.runtimes.turbowarp.total.filter((x) => x !== null).at(-1)!;
    expect(a).not.toBeCloseTo(b, 0);
  });

  it("carries the suite hash of each run so revisions can be marked", () => {
    const s = buildScores(ds());
    expect(s.suiteHashes.filter(Boolean).length).toBeGreaterThan(0);
  });
});

describe("buildScores with real projects", () => {
  const replay = (frames: number, ms: number, extra = {}) => ({
    frames, recorded_frames: 300, drifted: 0, hash: "0badf00d", hash_kind: "scratch-vm",
    checkpoints: { 30: ms / 10, [frames]: ms }, frame_ms: { median: ms }, ...extra,
  });
  // Adds a projects result for a runtime to a run, made like that run's performance result.
  const addProjects = (run: string, runtime: string, results: Record<string, unknown>) => {
    const perf = JSON.parse(fs.readFileSync(path.join(dir, run, `performance-${runtime}.json`), "utf8"));
    fs.writeFileSync(
      path.join(dir, run, `projects-${runtime}.json`),
      JSON.stringify({ ...perf, suite: { id: "projects", source_hash: "demo-projects" }, runs: [], stats: {}, results }),
    );
  };
  const runs = () =>
    fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, "performance-turbowarp.json"))).sort();
  const lastTotal = (s: ReturnType<typeof buildScores>, id: string) => s.runtimes[id].total.at(-1);

  it("scores projects only in runs where TurboWarp's replays can be compared", () => {
    const run = runs().at(-1)!;
    const host = loadDataset(dir).entries.find((e) => e.runId === run)!.hostId;
    const before = buildScores(loadDataset(dir), { host });
    const added: string[] = [];
    try {
      // An old-format run (no checkpoints): the totals stay the benchmarks'.
      addProjects(run, "turbowarp", { a: { ms: { median: 900 }, frames: 300 } });
      added.push("turbowarp");
      const old = buildScores(loadDataset(dir), { host });
      expect(lastTotal(old, "turbowarp")).toBe(lastTotal(before, "turbowarp"));
      expect(lastTotal(old, "scratch")).toBe(lastTotal(before, "scratch"));
      expect(old.runtimes.turbowarp.projects.at(-1)).toBeNull();
      expect(old.projectRuns.at(-1)).toBe(false);

      // TurboWarp replayed both projects; Scratch was half as fast on a and cut off on b.
      addProjects(run, "turbowarp", { a: replay(300, 500), b: replay(300, 1000) });
      addProjects(run, "scratch", { a: replay(300, 1000), b: replay(120, 2000) });
      added.push("scratch");
      const s = buildScores(loadDataset(dir), { host });
      const tw = s.runtimes.turbowarp.projects.at(-1)!;
      const sc = s.runtimes.scratch.projects.at(-1)!;
      // TurboWarp: 300 frames in 500 ms and in 1000 ms.
      expect(tw).toBeCloseTo(Math.sqrt((300 / 500) * (300 / 1000)), 2);
      // Scratch on a: half TurboWarp's speed. On b, compared at frame 30: 100 ms against 200 ms.
      expect(sc).toBeCloseTo(Math.sqrt(0.5 * (300 / 500) * 0.5 * (300 / 1000)), 2);
      // Only this run scored projects, so only its totals are of that kind.
      expect(s.projectRuns.at(-1)).toBe(true);
      expect(s.projectRuns.filter(Boolean).length).toBe(1);

      // Scratch failing the heavier project leaves its score at its speed on the other, rather
      // than moving it by how heavy the project it failed was.
      addProjects(run, "scratch", { a: replay(300, 1000), b: { error: "crashed" } });
      const failed = buildScores(loadDataset(dir), { host });
      expect(failed.runtimes.scratch.projects.at(-1)).toBeCloseTo(sc, 2);
      expect(lastTotal(s, "turbowarp")).not.toBe(lastTotal(before, "turbowarp"));
      // Runtimes in the run without replays can't be compared with those with them: no total.
      const others = Object.keys(s.runtimes).filter((id) =>
        id !== "turbowarp" && id !== "scratch" && fs.existsSync(path.join(dir, run, `performance-${id}.json`))
      );
      expect(others.length).toBeGreaterThan(0);
      for (const id of others) expect(lastTotal(s, id)).toBeNull();
      // Earlier runs are untouched.
      expect(s.runtimes.scratch.total.at(-2)).toBe(before.runtimes.scratch.total.at(-2));
    } finally {
      for (const id of added) fs.rmSync(path.join(dir, run, `projects-${id}.json`));
    }
  });
});
