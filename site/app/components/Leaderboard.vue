<script setup lang="ts">
import { CATEGORIES, CATEGORY_IDS } from "#shared/benchmarks";

const { host, baseline, weights, log } = useBenchState();
const { data: meta } = await useMetaData();
const { data: scores } = await useScoreData(host, weights);
const { data: latest } = await useLatestData(host);
const { nameOf, indexOf } = useRuntimes(meta, baseline);
const chart = useChartTheme();
const shown = useShown();
const replaying = ref(false);
const replaySeries = computed(() =>
  Object.entries(scores.value?.runtimes ?? {})
    .filter(([id]) => shown(id))
    .map(([id, s]) => ({ id, name: nameOf(id), values: totalsOfCurrentKind(scores.value, s.total) }))
);

const rows = computed(() => {
  const s = scores.value;
  if (!s) return [];
  const mapped = Object.entries(s.runtimes).map(([id, series]) => {
    const total = lastTotal(s, series.total);
    const rt = latest.value?.runtimes.find((r) => r.id === id);
    return {
      id,
      name: nameOf(id),
      total,
      change: change(total, previousTotal(s, series.total)),
      coverage: lastValue(series.coverage),
      version: rt?.version ?? "",
      timestamp: rt?.timestamp ?? null,
      stale: rt?.stale ?? false,
    };
  });
  const base = mapped.find((r) => r.id === baseline.value)?.total ?? null;
  return mapped
    .filter((r) => shown(r.id))
    .map((r) => ({
      ...r,
      speedup: r.total != null && base ? r.total / base : null,
    }))
    .sort((a, b) => (b.total ?? -1) - (a.total ?? -1));
});

const ranked = computed(() => rows.value.filter((r) => r.total != null));

const weightedUp = CATEGORY_IDS.filter((id) => CATEGORIES[id].weight > 1).map((
  id,
) => CATEGORIES[id].label);

const chartHeight = computed(() =>
  Math.max(224, ranked.value.length * 26 + 40)
);

const option = computed(() => {
  const values = ranked.value.map((r) => r.total!);
  const min = values.length ? Math.min(...values) : 1;
  return {
    ...chart.base(),
    grid: { left: 8, right: 64, top: 8, bottom: 24, containLabel: true },
    tooltip: {
      ...chart.base().tooltip,
      trigger: "item",
      formatter: (p: any) => `${p.name}: ${fmtOps(p.value)}`,
    },
    xAxis: {
      type: log.value ? "log" : "value",
      min: log.value ? 10 ** (Math.floor(Math.log10(min)) - 1) : 0,
      ...chart.axis(),
      axisLabel: {
        ...chart.axis().axisLabel,
        formatter: (v: number) => fmtOps(v),
      },
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: ranked.value.map((r) => r.name),
      ...chart.axis(),
      splitLine: { show: false },
    },
    series: [
      {
        type: "bar",
        barMaxWidth: 18,
        barCategoryGap: "30%",
        data: ranked.value.map((r) => ({
          value: r.total,
          itemStyle: { color: chart.runtimeColor(r.id, indexOf(r.id)) },
        })),
        label: {
          show: true,
          position: "right",
          color: chart.text(),
          formatter: (p: any) => fmtOps(p.value),
        },
      },
    ],
  };
});
</script>

<template>
  <section class="panel leaderboard" aria-labelledby="leaderboard-title">
    <header class="panel__header">
      <h2 id="leaderboard-title" class="panel__title">Overall Performance</h2>
      <p class="panel__subtitle">
        The geometric mean of every benchmark's result in operations per millisecond. Higher is faster.
        <template v-if="weights === 'default'">
          The more real-world categories count a little more ({{ weightedUp.join(", ") }}).
        </template>
        <template v-else>Every category counts equally.</template>
      </p>
    </header>

    <div class="bench-panel__toolbar">
      <ReplayToggle v-model="replaying" />
    </div>
    <BarReplay v-if="replaying && (scores?.timestamps.length ?? 0) > 1" :timestamps="scores!.timestamps"
      :series="replaySeries" :format="fmtOps" :log="log" label="Overall performance of each runtime" />
    <ChartBase v-else :option="option" small :height="chartHeight"
      :label="`Overall performance of each runtime, ${log ? 'logarithmic' : 'linear'} scale`" />

    <div class="table-scroll">
      <table class="table leaderboard__table">
        <thead>
          <tr>
            <th scope="col" class="table__rank">#</th>
            <th scope="col">Runtime</th>
            <th scope="col" class="table__number">Score</th>
            <th scope="col" class="table__number"
              :title="`How many times faster than ${nameOf(baseline)}`">vs {{ nameOf(baseline) }}</th>
            <th scope="col" class="table__number">Since last run</th>
            <th scope="col">Version</th>
            <th scope="col">Data from</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in rows" :key="r.id" class="table__row"
            :data-runtime="r.id"
            :data-state="r.total == null ? 'unranked' : r.stale ? 'stale' : 'ranked'">
            <td class="table__rank">{{ r.total == null ? "–" : i + 1 }}</td>
            <th scope="row" class="table__name">
            <span class="runtime-dot" :data-runtime="r.id" />
            {{ r.name }}
          </th>
            <td class="table__number table__strong">
              <template v-if="r.total != null">{{ fmtOps(r.total) }}</template>
              <span v-else class="table__note"
                title="Too few benchmarks completed to give a fair score">no score</span>
            </td>
            <td class="table__number">{{ fmtSpeedup(r.speedup) }}</td>
            <td class="table__number"
              :data-trend="r.change == null ? 'none' : r.change > 0.005 ? 'up' : r.change < -0.005 ? 'down' : 'flat'">
            {{ fmtChange(r.change) }}
          </td>
            <td class="table__mono">{{ r.version }}</td>
            <td>
            {{ fmtDate(r.timestamp) }}
            <span v-if="r.stale" class="badge" data-kind="warning">older</span>
          </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
