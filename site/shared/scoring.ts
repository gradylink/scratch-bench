import {
  BENCHMARK_BY_ID,
  BENCHMARKS,
  benchmarksIn,
  CATEGORIES,
  CATEGORY_IDS,
  type CategoryId,
} from "./benchmarks.ts";

export const SCORE_VERSION = 3;

/** Each real project counts as much as this many benchmarks of average weight in the total. */
export const PROJECT_WEIGHT = 2;

export const MIN_COVERAGE = 0.8;

export type WeightMode = "default" | "equal";

export type Medians = Record<string, number | null | undefined>;

export interface CategoryScore {
  score: number | null;
  coverage: number;
  counted: number;
  total: number;
}

export interface RuntimeScore {
  total: number | null;
  coverage: number;
  categories: Record<CategoryId, CategoryScore>;
  /** The real projects, when the run replayed them. */
  projects: CategoryScore | null;
}

/**
 * The runtime whose replays the others are compared with. There is no fallback: comparing some
 * projects with one runtime and others with another would mix scales in one score.
 */
export const PROJECT_REFERENCE = "turbowarp";

type Replayed = {
  error?: string | null;
  frames?: number | null;
  drifted?: number | null;
  checkpoints?: Record<string, number> | null;
  /** The project's state at each checkpoint (projects/REPLAY.md, "State"). */
  states?: Record<string, string> | null;
} | undefined;

/**
 * A replay whose state stopped agreeing with the reference's is compared on the frames before only
 * if there were at least this many: the first frames are mostly a project setting up, and a speed
 * from them says little about running it.
 */
export const MIN_AGREED_FRAMES = 30;

/**
 * How far a replay's state agreed with the reference's: `through` is the last checkpoint frame
 * both have a state for at which they still agreed, `differs` the first at which they didn't
 * ("mixed", a runtime whose own runs disagreed, never agrees). Null when either has no states
 * (older results), so there is nothing to check.
 */
export const agreement = (p: Replayed, reference: Replayed): { through: number | null; differs: number | null } | null => {
  if (!p?.states || !reference?.states) return null;
  const frames = Object.keys(p.states).map(Number).filter((f) => reference.states![f] !== undefined).sort((x, y) => x - y);
  const differs = frames.find((f) => p.states![f] !== reference.states![f] || p.states![f] === "mixed") ?? null;
  const through = frames.filter((f) => differs === null || f < differs).at(-1) ?? null;
  return { through, differs };
};

/** A replay that ran without error and did the recorded work (drifted on at most 1% of frames). */
const comparable = (p: Replayed): p is NonNullable<Replayed> =>
  !!p && !p.error && p.frames != null && !!p.checkpoints && (p.drifted ?? 0) <= p.frames * 0.01;

/**
 * A replay's checkpoints, as frame → script time, and its bound if it has one. A checkpoint past
 * the frames it reached is a bound: it was cut in a frame that didn't end (that frame's number),
 * and would have finished that frame, or any after it, no sooner. Compared there a runtime does no
 * worse than it deserves, so a runtime's bound counts, but a reference's never does.
 */
const marksOf = (p: NonNullable<Replayed>) => {
  const real: [number, number][] = [];
  let bound: [number, number] | null = null;
  for (const [f, ms] of Object.entries(p.checkpoints ?? {})) {
    if (!(ms > 0)) continue;
    if (Number(f) <= p.frames!) real.push([Number(f), ms]);
    else if (!bound || Number(f) < bound[0]) bound = [Number(f), ms];
  }
  return { real: real.sort(([x], [y]) => y - x), bound };
};

/**
 * How fast a replay ran against the reference's, on exactly the same frames: the reference's script
 * time over its own at the furthest checkpoint both reached (a runtime that couldn't get through the
 * recording in its time is compared on the frames it did), and only up to where its state still
 * agreed with the reference's (null if it never did). A replay cut in a frame the reference
 * got past is compared through its bound at the reference's first checkpoint from that frame on:
 * the bound holds at every later one too, but the first gives the tightest comparison, and a later
 * one could score a runtime that never finished a frame above the reference. 1 for the reference
 * itself; null when either can't be compared.
 */
export const relativeSpeed = (p: Replayed, reference: Replayed): number | null => {
  if (!comparable(p) || !comparable(reference)) return null;
  // Only the frames on which it computed what the reference did: past where its state stopped
  // agreeing, it was doing other work, and its time says nothing about running the project.
  const agreed = agreement(p, reference);
  if (agreed?.differs !== null && agreed?.differs !== undefined) {
    if (agreed.through === null || agreed.through < MIN_AGREED_FRAMES) return null;
    const until = agreed.through;
    const theirs = new Map(marksOf(reference).real.filter(([f]) => f <= until));
    const shared = marksOf(p).real.find(([f]) => f <= until && theirs.has(f));
    return shared ? theirs.get(shared[0])! / shared[1] : null;
  }
  const theirs = marksOf(reference).real;
  const mine = marksOf(p);
  if (mine.bound) {
    const after = theirs.filter(([f]) => f >= mine.bound![0]).at(-1);
    if (after) return after[1] / mine.bound[1];
  }
  const at = new Map(theirs);
  const shared = mine.real.find(([f]) => at.has(f));
  return shared ? at.get(shared[0])! / shared[1] : null;
};

/**
 * The reference's speed on a project, in frames per millisecond of script time, over as much of the
 * recording as it got through.
 */
export const referenceRate = (reference: Replayed): number | null => {
  if (!comparable(reference)) return null;
  const [furthest, ms] = marksOf(reference).real[0] ?? [];
  return furthest === undefined ? null : furthest / ms!;
};

/** The reference replay for a project among a run's results, if it can be compared. */
export const referenceFor = <T extends Replayed>(id: string, runtimes: Record<string, Record<string, T>>): T | undefined => {
  const p = runtimes[PROJECT_REFERENCE]?.[id];
  return comparable(p) && marksOf(p).real.length ? p : undefined;
};

/** The share of the total an average benchmark has: its category's weight over its category's size. */
const averageBenchmarkWeight = (mode: WeightMode): number =>
  CATEGORY_IDS.reduce((n, id) => n + categoryWeight(id, mode), 0) / BENCHMARKS.length;

const usable = (x: number | null | undefined): x is number =>
  typeof x === "number" && Number.isFinite(x) && x > 0;

export const geometricMean = (
  items: { value: number; weight: number }[],
): number | null => {
  let sum = 0;
  let weights = 0;
  for (const { value, weight } of items) {
    if (!(weight > 0) || !(value > 0)) continue;
    sum += weight * Math.log(value);
    weights += weight;
  }
  return weights > 0 ? Math.exp(sum / weights) : null;
};

export const categoryWeight = (id: CategoryId, mode: WeightMode): number =>
  mode === "equal" ? 1 : CATEGORIES[id].weight;

/**
 * The real projects a run scored, for one runtime: its speed against the reference on each
 * (relativeSpeed; null where it can't be compared), and the reference's own speed over all of them
 * (the geometric mean of their referenceRate), which puts the projects' score in frames per
 * millisecond, absolute like the benchmarks'.
 */
export interface ProjectScores {
  speeds: Medians;
  scale: number;
}

/**
 * Without `projects` the total is the benchmarks' alone, as for runs that scored no projects; with
 * it, a runtime with none of them comparable has no total, since its total wouldn't be comparable
 * with the others'. Projects it couldn't be compared on are left out of its projects score, which
 * is the geometric mean of its speeds on the others times `projects.scale`: leaving a project out
 * changes it only by how fast the runtime was on that project, not by the project's size.
 */
export const scoreRuntime = (
  runtime: Medians,
  mode: WeightMode = "default",
  projects?: ProjectScores,
): RuntimeScore => {
  const categories = {} as Record<CategoryId, CategoryScore>;
  let counted = 0;
  let all = 0;

  for (const id of CATEGORY_IDS) {
    const benches = benchmarksIn(id);
    const values: { value: number; weight: number }[] = [];
    for (const bench of benches) {
      const v = runtime[bench.id];
      if (usable(v)) {
        values.push({
          value: v,
          weight: mode === "equal" ? 1 : bench.weight ?? 1,
        });
      }
    }
    const coverage = benches.length ? values.length / benches.length : 0;
    counted += values.length;
    all += benches.length;
    categories[id] = {
      score: coverage >= MIN_COVERAGE ? geometricMean(values) : null,
      coverage,
      counted: values.length,
      total: benches.length,
    };
  }

  let projectScore: CategoryScore | null = null;
  const ids = Object.keys(projects?.speeds ?? {});
  if (ids.length) {
    const speeds = ids.map((id) => projects!.speeds[id]).filter(usable);
    const coverage = speeds.length / ids.length;
    const speed = speeds.length ? geometricMean(speeds.map((value) => ({ value, weight: 1 }))) : null;
    projectScore = {
      score: speed === null ? null : speed * projects!.scale,
      coverage,
      counted: speeds.length,
      total: ids.length,
    };
  }

  const parts = CATEGORY_IDS.map((id) => ({
    score: categories[id].score,
    weight: categoryWeight(id, mode),
  }));
  if (projectScore) {
    parts.push({
      score: projectScore.score,
      // The same weight for every runtime, however many projects it was compared on: totals are
      // only comparable between runtimes weighted alike, since the projects' frames per
      // millisecond and the benchmarks' operations per millisecond are on very different scales.
      // (Weighted by its own count, a runtime compared on fewer projects would lean less on the
      // projects' small numbers and come out ahead for it.)
      weight: PROJECT_WEIGHT * ids.length * averageBenchmarkWeight(mode),
    });
  }
  const complete = parts.every((p) => p.score !== null);
  const total = complete
    ? geometricMean(parts.map((p) => ({ value: p.score!, weight: p.weight })))
    : null;

  return { total, coverage: all ? counted / all : 0, categories, projects: projectScore };
};

export const ratioToBaseline = (
  value: number | null | undefined,
  base: number | null | undefined,
): number | null => usable(value) && usable(base) ? value / base : null;

export const unknownBenchmarks = (medians: Medians): string[] =>
  Object.keys(medians).filter((id) => !BENCHMARK_BY_ID[id]);
