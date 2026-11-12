export interface Summary {
  n: number;
  median: number;
  mean: number;
  stddev: number;
  min: number;
  max: number;
}

export interface HostInfo {
  id: string;
  label: string;
  cpu: string;
  cores: number;
  memory_gb: number;
  os: string;
  runs: number;
  first: string;
  last: string;
}

export interface VariantInfo {
  id: string;
  name: string;
  default: boolean;
}

export interface RuntimeInfo {
  id: string;
  base: string;
  variant: VariantInfo | null;
  name: string;
  kind: string;
  version: string;
  launcher: string | null;
}

export interface Meta {
  runtimes: RuntimeInfo[];
  hasVariants: boolean;
  hosts: HostInfo[];
  suites: string[];
  runCount: number;
  latest: string | null;
  scoreVersion: number;
  demo: boolean;
  warnings: string[];
}

export interface ParitySummary {
  verdict: "passed" | "failed" | "unknown";
  passed: number | null;
  total: number | null;
  failed_groups: {
    name: string;
    passed: number;
    total: number;
    failures: string[];
  }[];
}

export interface LatestRuntime {
  id: string;
  base: string;
  variant: VariantInfo | null;
  name: string;
  kind: string;
  version: string;
  launcher: string | null;
  display: string | null;
  timestamp: string;
  stale: boolean;
  suiteHash: string;
  repoSha: string | null;
  runs: { ok: number; total: number };
  benchmarks: Record<string, Summary | null>;
  startup_ms: Summary | null;
  run_ms: Summary | null;
  peak_rss_mb: Summary | null;
  parity: (ParitySummary & { timestamp: string; stale: boolean }) | null;
}

/** One recorded project replayed in one runtime (projects/REPLAY.md). */
export interface ProjectResult {
  /** Set when the replay failed; the rest is then empty. */
  error: string | null;
  /** The project's title (results from before titles were recorded have none). */
  title: string | null;
  /** Real time for the frames, back to back, without hashing: what the replay's budget counts. */
  frame_ms: Summary | null;
  /** Of that, stepping the frames (handling inputs and running scripts): the runtime's speed. */
  script_ms: Summary | null;
  /** Of that, drawing the stage and waiting for the GPU. */
  draw_ms: Summary | null;
  /** Older results' real time. */
  wall_ms: Summary | null;
  /** Frames replayed, of the recording's; fewer when it ran out of time. */
  frames: number | null;
  recorded_frames: number | null;
  /** Frames that made a different number of passes than recorded: different work. */
  drifted: number | null;
  /**
   * The project's state through the replay, as 8 hex digits; a runtime computing something else
   * differs. "mixed" when its runs disagreed, "unfinished" when a frame never ended; null when its
   * runs stopped at different frames.
   */
  hash: string | null;
  /** How the hash was made: "state" (projects/REPLAY.md) in every runner; older results differ. */
  hash_kind: string | null;
  /** The project's state at each checkpoint, to check against TurboWarp's (newer results). */
  states?: Record<string, string> | null;
  /** Script time so far at set frames (1, 2, 3, 5, 8, ... and the last reached). */
  checkpoints: Record<string, number> | null;
  /** Older results, from replays in real time. */
  ms?: Summary | null;
  recorded_ms?: number | null;
  ticks?: number | null;
  recorded_ticks?: number | null;
  long_frames?: number | null;
}

export interface LatestProjects {
  id: string;
  name: string;
  launcher: string | null;
  timestamp: string;
  stale: boolean;
  projects: Record<string, ProjectResult>;
}

export interface LatestParity {
  id: string;
  name: string;
  parity: ParitySummary & { timestamp: string; stale: boolean };
}

export interface Latest {
  host: string;
  timestamp: string | null;
  runtimes: LatestRuntime[];
  parity: LatestParity[];
  projects: LatestProjects[];
}

export interface HistoryRuntime {
  versions: (string | null)[];
  startup_ms: (number | null)[];
  peak_rss_mb: (number | null)[];
  parity_passed: (number | null)[];
  parity_total: (number | null)[];
  backfilled: boolean[];
  bench: Record<string, (number | null)[]>;
  rsd: Record<string, (number | null)[]>;
}

export interface History {
  host: string;
  timestamps: string[];
  suiteHashes: (string | null)[];
  shas: (string | null)[];
  runtimes: Record<string, HistoryRuntime>;
}

export interface ScoreSeries {
  total: (number | null)[];
  categories: Record<string, (number | null)[]>;
  /** The real-projects score (frames per ms of script time), where a run has projects. */
  projects: (number | null)[];
  coverage: (number | null)[];
}

export interface ScoreHistory {
  host: string;
  weights: "default" | "equal";
  scoreVersion: number;
  timestamps: string[];
  /**
   * Whether each run scored real projects. Its totals then count them, so they aren't on the same
   * scale as a run's that didn't: compare totals only between runs alike (see lastTotal).
   */
  projectRuns: boolean[];
  suiteHashes: (string | null)[];
  runtimes: Record<string, ScoreSeries>;
}

export interface BenchStatus {
  running: boolean;
  startedAt: string | null;
  lastRun: {
    startedAt: string;
    finishedAt: string;
    ok: boolean;
    message: string;
    durationMs: number;
  } | null;
  nextRun: string | null;
  schedule: string | null;
}
