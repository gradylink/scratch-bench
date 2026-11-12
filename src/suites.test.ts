import { expect, test } from "bun:test";
import { parity, projects } from "./suites.ts";

test("parity.parse attaches each failure message to its group", () => {
  const d = parity.parse([
    "Scratch Parity Test: 2656 tests in 206 groups",
    "[FAILED] Data: List Contents: 22/23 (95.65217391304348%)",
    "┗ Test 9 Failed: a number item forces space-joining | got 'a1' (expected 'a 1')",
    "[FAILED] Motion: If On Edge Bounce: 0/16 (0%)",
    "┗ Only 0 of 16 tests in this group ran: a script stopped early",
    "[FAILED] 2639 of 2656 tests ran, in 206 of 206 groups",
    "[FAILED] Some Tests Were Not Successful: 2639/2656 (99.35993975903614%)",
  ]);
  expect(d).toEqual({
    verdict: "failed",
    passed: 2639,
    total: 2656,
    failed_groups: [
      {
        name: "Data: List Contents",
        passed: 22,
        total: 23,
        failures: [
          "Test 9 Failed: a number item forces space-joining | got 'a1' (expected 'a 1')",
        ],
      },
      {
        name: "Motion: If On Edge Bounce",
        passed: 0,
        total: 16,
        failures: ["Only 0 of 16 tests in this group ran: a script stopped early"],
      },
    ],
  });
});

test("parity.parse reads the older format without messages", () => {
  const d = parity.parse([
    "[FAILED] Costume Switching Tests: 9/11 (81.81818181818183%)",
    "┣ Test 5 Failed",
    "┗ Test 6 Failed",
    "[FAILED] Some Tests Were Not Successful: 310/315 (98.4126984126984%)",
  ]);
  expect(d.failed_groups).toEqual([{
    name: "Costume Switching Tests",
    passed: 9,
    total: 11,
    failures: ["Test 5 Failed", "Test 6 Failed"],
  }]);
});

test("projects.parse reads each replay's result line, or its error", () => {
  expect(projects.parse([
    "324569477 | 1726.5 | 420.5 | 2930.6 | 971/971 | 0 | f8c55320 | 1:12.5:0011aaff,2:20:0022bbee,971:1726.5:f8c55320",
    // Cut in frame 311: a bound, with no state.
    "1201938491 | 41012.3 | 900.1 | 60012 | 310/510 | 2 | unfinished | 300:38012.3:0a1b2c3d,311:41012.3",
    "1274137785 | error | a frame ran for over a minute",
    "DONE",
  ])).toEqual({
    "324569477": {
      script_ms: 1726.5,
      draw_ms: 420.5,
      frame_ms: 2930.6,
      frames: 971,
      recorded_frames: 971,
      drifted: 0,
      hash: "f8c55320",
      checkpoints: { 1: 12.5, 2: 20, 971: 1726.5 },
      states: { 1: "0011aaff", 2: "0022bbee", 971: "f8c55320" },
    },
    "1201938491": {
      script_ms: 41012.3,
      draw_ms: 900.1,
      frame_ms: 60012,
      frames: 310,
      recorded_frames: 510,
      drifted: 2,
      hash: "unfinished",
      checkpoints: { 300: 38012.3, 311: 41012.3 },
      states: { 300: "0a1b2c3d" },
    },
    "1274137785": { error: "a frame ran for over a minute" },
  });
});
