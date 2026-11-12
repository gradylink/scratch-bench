import { CATEGORIES, CATEGORY_IDS } from "#shared/benchmarks";
import type { Measure } from "./ranking";

export interface CompareMetric extends Measure {
  label: string;
  fmt: (v: number) => string;
  linear?: boolean;
  value: (id: string) => number | null;
}

export const useCompareMetrics = () => {
  const { host, weights } = useBenchState();
  const { data: scores } = useScoreData(host, weights);
  const { data: latest } = useLatestData(host);
  const run = (id: string) => latest.value?.runtimes.find((r) => r.id === id);
  return computed<CompareMetric[]>(() => [
    {
      id: "speed",
      label: "Speed",
      better: "higher",
      fmt: fmtOps,
      value: (id) => lastTotal(scores.value, scores.value?.runtimes[id]?.total),
    },
    {
      id: "startup",
      label: "Startup time",
      better: "lower",
      fmt: fmtMs,
      value: (id) => run(id)?.startup_ms?.median ?? null,
    },
    {
      id: "memory",
      label: "Peak memory",
      better: "lower",
      fmt: fmtMb,
      value: (id) => run(id)?.peak_rss_mb?.median ?? null,
    },
    {
      id: "compat",
      label: "Compatibility",
      better: "higher",
      fmt: (v) => fmtPercent(v),
      linear: true,
      value: (id) => {
        const p = run(id)?.parity;
        return p?.total ? (p.passed ?? 0) / p.total : null;
      },
    },
    ...CATEGORY_IDS.map((c): CompareMetric => ({
      id: c,
      label: `${CATEGORIES[c].label} speed`,
      better: "higher",
      fmt: fmtOps,
      value: (id) => lastValue(scores.value?.runtimes[id]?.categories[c]),
    })),
  ]);
};
