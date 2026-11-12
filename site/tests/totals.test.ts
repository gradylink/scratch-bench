import { describe, expect, it } from "vitest";
import { lastTotal, previousTotal } from "../app/composables/useScoring.ts";
import type { ScoreHistory } from "../shared/types.ts";

const history = (projectRuns: boolean[]) =>
  ({ projectRuns, timestamps: projectRuns.map((_, i) => `t${i}`) }) as unknown as ScoreHistory;

describe("totals of one kind", () => {
  it("takes the latest total only from runs of the latest run's kind", () => {
    const s = history([false, false, true, true]);
    // Can replay: its latest total with projects, and the one before it of the same kind.
    expect(lastTotal(s, [1, 2, 30, 31])).toBe(31);
    expect(previousTotal(s, [1, 2, 30, 31])).toBe(30);
    // Its first total with projects has nothing of its kind to change from.
    expect(previousTotal(s, [1, 2, null, 31])).toBeNull();
    // Can't replay: no total of the latest kind, rather than an older benchmarks-only one.
    expect(lastTotal(s, [1, 2, null, null])).toBeNull();
  });

  it("works on runs from before projects were scored", () => {
    expect(lastTotal(history([false, false]), [1, 2])).toBe(2);
    expect(lastTotal({ timestamps: ["a", "b"] } as unknown as ScoreHistory, [1, null])).toBe(1);
  });
});
