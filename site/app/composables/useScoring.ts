import type { ScoreHistory } from "#shared/types";

export const lastIndex = (series: (number | null)[] | undefined): number => {
  if (!series) return -1;
  for (let i = series.length - 1; i >= 0; i--) if (series[i] != null) return i;
  return -1;
};

export const lastValue = (
  series: (number | null)[] | undefined,
): number | null => {
  const i = lastIndex(series);
  return i < 0 ? null : series?.[i] ?? null;
};

export const previousValue = (
  series: (number | null)[] | undefined,
): number | null => {
  const i = lastIndex(series);
  if (i <= 0) return null;
  for (let j = i - 1; j >= 0; j--) {
    if (series?.[j] != null) return series[j] ?? null;
  }
  return null;
};

/**
 * The kind of total the site shows: with real projects once any run has scored them (a later run
 * that didn't, say one re-running a single runtime, doesn't switch it back), otherwise without.
 */
export const currentKind = (scores: ScoreHistory | null | undefined): boolean =>
  (scores?.projectRuns ?? []).includes(true);

/** A runtime's totals, with those from runs of the other kind than currentKind left out (null). */
export const totalsOfCurrentKind = (
  scores: ScoreHistory | null | undefined,
  series: (number | null)[] | undefined,
): (number | null)[] => {
  const kind = currentKind(scores);
  return (series ?? []).map((v, i) => ((scores?.projectRuns?.[i] ?? false) === kind ? v : null));
};

/**
 * The latest total in a runtime's series of the current kind (with projects or without): totals
 * of different kinds aren't on one scale, so a runtime without one of that kind has none, rather
 * than an older one of the other kind.
 */
export const lastTotal = (
  scores: ScoreHistory | null | undefined,
  series: (number | null)[] | undefined,
): number | null => totalsOfKind(scores, series).at(-1) ?? null;

/** The total before lastTotal, from a run of the same kind. */
export const previousTotal = (
  scores: ScoreHistory | null | undefined,
  series: (number | null)[] | undefined,
): number | null => totalsOfKind(scores, series).at(-2) ?? null;

const totalsOfKind = (
  scores: ScoreHistory | null | undefined,
  series: (number | null)[] | undefined,
): number[] => totalsOfCurrentKind(scores, series).filter((v): v is number => v != null);

export const useRankedRuntimeIds = (
  host: Ref<string>,
  weights: Ref<string>,
) => {
  const { data: scores } = useScoreData(host, weights);
  return computed(() =>
    Object.entries(scores.value?.runtimes ?? {})
      .map(([id, s]) => ({ id, total: lastTotal(scores.value, s.total) }))
      .sort((a, b) => (b.total ?? -1) - (a.total ?? -1))
      .map((r) => r.id)
  );
};
