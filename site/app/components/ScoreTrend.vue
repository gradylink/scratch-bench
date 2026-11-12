<script setup lang="ts">
const { host, baseline, weights, trendRange: range, log } = useBenchState();
const { data: meta } = await useMetaData();
const { data: scores } = await useScoreData(host, weights);
const { nameOf, indexOf } = useRuntimes(meta, baseline);
const chart = useChartTheme();
const shown = useShown();

const option = computed(() => {
  const s = scores.value;
  const from = rangeStart(range.value, s?.timestamps.at(-1));
  const start = from ? s!.timestamps.findIndex((t) => t >= from) : 0;
  const first = Math.max(0, start);
  const revisions: string[] = [];
  let prevHash: string | null = null;
  (s?.suiteHashes ?? []).forEach((hash, i) => {
    const at = s!.timestamps[i];
    if (hash && prevHash && hash !== prevHash && at && (!from || at >= from)) {
      revisions.push(at);
    }
    if (hash) prevHash = hash;
  });
  const series = Object.entries(s?.runtimes ?? {}).filter(([id]) => shown(id))
    .map(([id, v], n) => {
      let lastKind: boolean | null = null;
      return {
      name: nameOf(id),
      type: "line",
      showSymbol: false,
      connectNulls: false,
      lineStyle: {
        width: 2,
        color: chart.runtimeColor(id, indexOf(id)),
        type: chart.lineType(id),
      },
      itemStyle: { color: chart.runtimeColor(id, indexOf(id)) },
      // Totals from runs that scored real projects aren't on the same scale as those from runs
      // that didn't, so the line breaks where that changes.
      data: s!.timestamps.slice(first).flatMap((t, i) => {
        const total = v.total[first + i];
        if (total == null) return [];
        const kind = s!.projectRuns?.[first + i] ?? false;
        const point: [string, number | null][] = [[t, total]];
        if (kind !== lastKind && lastKind !== null) point.unshift([t, null]);
        lastKind = kind;
        return point;
      }),
      markLine: n === 0 && revisions.length
        ? {
          silent: true,
          symbol: "none",
          lineStyle: { color: chart.muted(), type: "dashed" },
          label: {
            formatter: "benchmarks revised",
            color: chart.muted(),
            position: "insideEndTop",
          },
          data: revisions.map((t) => ({ xAxis: t })),
        }
        : undefined,
    };
    });
  return chart.narrow({
    ...chart.base(),
    grid: {
      left: 8,
      right: 16,
      top: 16,
      bottom: 56 + chart.legendExtra(series.length),
      containLabel: true,
    },
    tooltip: {
      ...chart.base().tooltip,
      trigger: "axis",
      valueFormatter: (v: number | null) => fmtOps(v),
    },
    legend: { ...chart.base().legend, bottom: 28 },
    xAxis: { type: "time", ...chart.axis() },
    yAxis: {
      type: log.value ? "log" : "value",
      ...chart.axis(),
      axisLabel: {
        ...chart.axis().axisLabel,
        formatter: (v: number) => fmtOps(v),
      },
    },
    dataZoom: [{
      type: "slider",
      height: 16,
      bottom: 4,
      textStyle: { color: chart.muted() },
    }, { type: "inside" }],
    series,
  });
});
</script>

<template>
  <section class="panel score-trend" aria-labelledby="trend-title">
    <header class="panel__header">
      <h2 id="trend-title" class="panel__title">Performance over time</h2>
      <RangePicker scope="trend" />
    </header>
    <p v-if="scores && scores.timestamps.length < 2"
      class="panel__note">History appears here once there is more than one run.</p>
    <ChartBase :option="option" :height="560"
      label="Overall performance of each runtime over time" />
  </section>
</template>
