import path from "node:path";
import { ROOT } from "./paths.ts";
import type { Command } from "./runtimes/types.ts";

export interface PerfRecord {
  total_ms: number;
  ops: number;
  ops_per_ms: number;
  best_ops_per_ms: number;
  checksum: string;
}

export interface ParityData {
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

/** One recorded project replayed (see runtimes/chromium/index.html `replay`). */
export type ProjectRun =
  | {
    /** Real time spent stepping the recorded frames. */
    ms: number;
    frames: number;
    recorded_frames: number;
    worst_frame_ms: number;
    /** Frames that ran fewer ticks than recorded: the replay drifted from the recording. */
    short_frames: number;
    load_ms: number;
  }
  | { error: string };

export interface Suite<T = unknown> {
  id: "performance" | "parity" | "projects";
  source: string;
  launcher: "headless" | "gui";
  runs: number;
  isDone(line: string): boolean;
  parse(lines: string[]): T;
  /** Whether a runtime's launcher can run this suite; all can when absent. */
  supports?(command: Command): boolean;
}

const PERF_LINE =
  /^(\S+) \| ([\d.\-e+]+) \| ([\d.\-e+]+) \| ([\d.\-e+]+) \| ([\d.\-e+]+) \| (.*)$/;

export const performance: Suite<Record<string, PerfRecord>> = {
  id: "performance",
  source: "performance/project",
  launcher: "headless",
  runs: 10,
  isDone: (line) => line === "DONE",
  parse(lines) {
    const out: Record<string, PerfRecord> = {};
    for (const line of lines) {
      const m = PERF_LINE.exec(line);
      if (!m || m[1] === "id") continue;
      out[m[1]] = {
        total_ms: Number(m[2]),
        ops: Number(m[3]),
        ops_per_ms: Number(m[4]),
        best_ops_per_ms: Number(m[5]),
        checksum: m[6],
      };
    }
    return out;
  },
};

const PARITY_VERDICT = /Tests Were (Not )?Successful: (\d+)\/(\d+)/;

export const parity: Suite<ParityData> = {
  id: "parity",
  source: "parity/project",
  launcher: "gui",
  runs: 1,
  isDone: (line) => /Tests Were (Not )?Successful/.test(line),
  parse(lines) {
    const data: ParityData = {
      verdict: "unknown",
      passed: null,
      total: null,
      failed_groups: [],
    };
    for (const line of lines) {
      const v = PARITY_VERDICT.exec(line);
      if (v) {
        data.verdict = v[1] ? "failed" : "passed";
        data.passed = Number(v[2]);
        data.total = Number(v[3]);
      }
      const f = /^\[FAILED\] (.+?): (\d+)\/(\d+) /.exec(line);
      if (f && !v) {
        data.failed_groups.push({
          name: f[1],
          passed: Number(f[2]),
          total: Number(f[3]),
          failures: [],
        });
      }
      // "┣ Test 3 Failed: <what it checks> | got <what the runtime produced>" under its group
      const t = /^[┣┗] (.+)$/.exec(line);
      if (t) data.failed_groups.at(-1)?.failures.push(t[1]);
    }
    return data;
  },
};

const PROJECT_LINE = /^(\d+) \| ([\d.]+) \| (\d+)\/(\d+) \| ([\d.]+) \| (\d+) \| ([\d.]+)$/;

/** Real projects replaying recorded play. Opt-in: needs `bun run fetch-projects` first. */
export const projects: Suite<Record<string, ProjectRun>> = {
  id: "projects",
  source: "projects",
  launcher: "gui",
  runs: 1,
  isDone: (line) => line === "DONE",
  // Only the browser runner can replay recordings so far. MistWarp and 02engine check the tick
  // timer after ticks rather than before, so they can't be held to the recorded tick counts.
  supports: (command) => {
    const i = command.cmd.findIndex((arg) => arg.endsWith("chromium-vm.mjs"));
    return i >= 0 && !["mistwarp", "02engine"].includes(command.cmd[i + 1]);
  },
  parse(lines) {
    const out: Record<string, ProjectRun> = {};
    for (const line of lines) {
      const m = PROJECT_LINE.exec(line);
      if (m) {
        out[m[1]] = {
          ms: Number(m[2]),
          frames: Number(m[3]),
          recorded_frames: Number(m[4]),
          worst_frame_ms: Number(m[5]),
          short_frames: Number(m[6]),
          load_ms: Number(m[7]),
        };
      } else {
        const e = /^(\d+) \| error \| (.*)$/.exec(line);
        if (e) out[e[1]] = { error: e[2] };
      }
    }
    return out;
  },
};

/** The suites run when none are named. */
export const SUITES = [performance, parity] as Suite<any>[];

export const selectSuites = (ids: string[] | undefined): Suite<any>[] => {
  if (!ids) return SUITES;
  const all = [...SUITES, projects] as Suite<any>[];
  return ids.map((id) => {
    const s = all.find((x) => x.id === id);
    if (!s) {
      throw new Error(
        `unknown suite "${id}" (known: ${all.map((x) => x.id).join(", ")})`,
      );
    }
    return s;
  });
};

export const suiteSourceDir = (s: Suite) => path.join(ROOT, s.source);
