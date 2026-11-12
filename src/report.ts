import { CATEGORIES, CATEGORY_IDS } from "../site/shared/benchmarks.ts";
import {
  type Medians,
  SCORE_VERSION,
  scoreRuntime,
} from "../site/shared/scoring.ts";
import { agreement, referenceFor, relativeSpeed } from "../site/shared/scoring.ts";
import type { VariantInfo } from "./runtimes/types.ts";
import type { Summary } from "./stats.ts";
import { labelOf } from "./variants.ts";

export interface SuiteResult {
  schema_version: 1;
  timestamp: string;
  suite: { id: string; source_hash: string };
  repo: { sha: string | null; dirty: boolean; parity_sha: string | null };
  runtime: {
    id: string;
    name: string;
    kind: string;
    version: string;
    detail: Record<string, string>;
    launcher: "headless" | "gui" | null;
    display: string | null;
    variant?: VariantInfo | null;
  };
  host: Record<string, unknown>;
  runs: {
    ok: boolean;
    error?: string;
    startup_ms: number | null;
    run_ms: number | null;
    wall_ms: number | null;
    peak_rss_mb: number | null;
    data?: unknown;
    tail?: string[];
  }[];
  stats: Record<string, Summary | null>;
  results: unknown;
  error?: string;
  skipped?: string;
}

const num = (
  x: number,
  digits = 4,
) => (x >= 1000
  ? Math.round(x).toLocaleString("en-US")
  : Number(x.toPrecision(digits)).toString());

const table = (header: string[], rows: string[][]): string => {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length))
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i])))
      .join("  ");
  return [
    line(header),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...rows.map(line),
  ].join("\n");
};

type PerfBench = { ops_per_ms: Summary | null };

export const renderReport = (results: SuiteResult[]): string => {
  const out: string[] = [];

  const perf = results.filter((r) => r.suite.id === "performance");
  if (perf.length) {
    const ids = [
      ...new Set(
        perf.flatMap((r) =>
          Object.keys((r.results as Record<string, PerfBench>) ?? {})
        ),
      ),
    ];
    out.push("Performance: median ops/ms over runs (relative stddev)\n");
    out.push(
      table(
        [
          "benchmark",
          ...perf.map((r) => labelOf(r.runtime.name, r.runtime.variant)),
        ],
        ids.map((id) => [
          id,
          ...perf.map((r) => {
            const s = ((r.results as Record<string, PerfBench>) ?? {})[id]
              ?.ops_per_ms;
            return s
              ? `${num(s.median)} (${
                s.mean ? ((s.stddev / s.mean) * 100).toFixed(1) : "0.0"
              }%)`
              : "-";
          }),
        ]),
      ),
    );
    out.push("");

    const mediansOf = (r: SuiteResult): Medians =>
      Object.fromEntries(
        Object.entries((r.results as Record<string, PerfBench>) ?? {}).map((
          [id, v],
        ) => [id, v.ops_per_ms?.median ?? null]),
      );
    out.push(
      `Scores: weighted geometric mean of ops/ms, higher is faster (scoring version ${SCORE_VERSION})\n`,
    );
    const scored = perf
      .map((r) => ({ r, s: scoreRuntime(mediansOf(r)) }))
      .sort((a, b) => (b.s.total ?? -1) - (a.s.total ?? -1));
    const x = (v: number | null | undefined) => (v == null ? "-" : num(v));
    out.push(
      table(
        ["runtime", "overall", ...CATEGORY_IDS.map((c) => CATEGORIES[c].label)],
        scored.map(({ r, s }) => [
          labelOf(r.runtime.name, r.runtime.variant),
          x(s.total),
          ...CATEGORY_IDS.map((c) => x(s.categories[c].score)),
        ]),
      ),
    );
    out.push("");
  }

  out.push(
    "Startup and memory (median over successful runs; min-max in brackets)\n",
  );
  const range = (s: Summary | null | undefined, unit: string) =>
    s ? `${num(s.median)}${unit} [${num(s.min)}-${num(s.max)}]` : "-";
  out.push(
    table(
      [
        "suite",
        "runtime",
        "launcher",
        "runs ok",
        "startup",
        "run time",
        "peak RSS",
      ],
      results.filter((r) => !r.skipped).map((r) => [
        r.suite.id,
        labelOf(r.runtime.name, r.runtime.variant),
        r.runtime.launcher
          ? `${r.runtime.launcher}${
            r.runtime.display ? `/${r.runtime.display}` : ""
          }`
          : "-",
        `${r.runs.filter((x) => x.ok).length}/${r.runs.length}`,
        range(r.stats.startup_ms, " ms"),
        range(r.stats.run_ms, " ms"),
        range(r.stats.peak_rss_mb, " MB"),
      ]),
    ),
  );
  out.push("");

  const projects = results.filter((r) =>
    r.suite.id === "projects" && !r.skipped && Object.keys(r.results ?? {}).length
  );
  if (projects.length) {
    type Replayed = {
      title?: string;
      hash_kind?: string;
      frame_ms?: Summary;
      frames?: number;
      recorded_frames?: number;
      drifted?: number;
      hash?: string | null;
      checkpoints?: Record<string, number>;
      states?: Record<string, string>;
      error?: string;
    };
    const resultsOf = (r: SuiteResult) => (r.results as Record<string, Replayed>) ?? {};
    const nameOf = (r: SuiteResult) => labelOf(r.runtime.name, r.runtime.variant);
    const ids = [...new Set(projects.flatMap((r) => Object.keys(resultsOf(r))))];
    const byRuntime = Object.fromEntries(projects.map((r) => [r.runtime.id, resultsOf(r)]));
    out.push(
      "Projects: speed against TurboWarp on the same frames (frames reached when it ran out of time; " +
        "≠@n: its state stopped agreeing with TurboWarp's at frame n, so it's compared on the frames " +
        "before; * drifted from the recorded passes)\n",
    );
    out.push(
      table(
        ["project", ...projects.map(nameOf)],
        ids.map((id) => [
          projects.map((r) => resultsOf(r)[id]?.title).find(Boolean) ?? id,
          ...projects.map((r) => {
            const p = resultsOf(r)[id];
            if (!p) return "-";
            if (p.error) return "error";
            const reference = referenceFor(id, byRuntime);
            const speed = relativeSpeed(p, reference);
            const differs = agreement(p, reference)?.differs ?? null;
            const reached = p.frames! < p.recorded_frames! ? ` (${p.frames}/${p.recorded_frames})` : "";
            return `${differs !== null ? `≠@${differs} ` : ""}${p.drifted ? "*" : ""}${speed === null ? "-" : `${speed.toFixed(2)}×`}${reached}`;
          }),
        ]),
      ),
    );
    out.push("");
  }

  const parity = results.filter((r) => r.suite.id === "parity");
  if (parity.length) {
    out.push("Parity\n");
    for (const r of parity) {
      const d = r.results as {
        verdict: string;
        passed: number | null;
        total: number | null;
        failed_groups: {
          name: string;
          passed: number;
          total: number;
          failures?: string[];
        }[];
      } | null;
      if (r.skipped) {
        out.push(
          `${
            labelOf(r.runtime.name, r.runtime.variant)
          }: skipped (${r.skipped})`,
        );
        continue;
      }
      if (!d) {
        out.push(
          `${labelOf(r.runtime.name, r.runtime.variant)}: no result (${
            r.error ?? r.runs.find((x) => x.error)?.error ?? "unknown error"
          })`,
        );
        continue;
      }
      const pct = d.total
        ? ` (${((d.passed! / d.total) * 100).toFixed(1)}%)`
        : "";
      out.push(
        `${
          labelOf(r.runtime.name, r.runtime.variant)
        }: ${d.verdict} ${d.passed}/${d.total}${pct}`,
      );
      for (const g of d.failed_groups) {
        out.push(`  ${g.name}: ${g.passed}/${g.total}`);
        for (const f of g.failures ?? []) out.push(`    ${f}`);
      }
    }
    out.push("");
  }

  const failed = results.filter((r) =>
    !r.skipped && (r.runs.some((x) => !x.ok) || r.error)
  );
  if (failed.length) {
    out.push("Failures\n");
    for (const r of failed) {
      if (r.error) {
        out.push(
          `${r.suite.id} / ${
            labelOf(r.runtime.name, r.runtime.variant)
          }: ${r.error}`,
        );
      }
      r.runs.forEach((x, i) => {
        if (!x.ok) {
          out.push(
            `${r.suite.id} / ${
              labelOf(r.runtime.name, r.runtime.variant)
            } run ${i + 1}: ${x.error}`,
          );
        }
      });
    }
    out.push("");
  }
  return out.join("\n");
};
