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

test("projects.parse reads each replayed project, cut short or failed", () => {
  expect(projects.parse([
    "714869495 | 9179.5 | 1247/1247 | 826.5 | 4 | 1168.6",
    "1201938491 | 300012.3 | 300/510 | 1221.6 | 0 | 8287.2",
    "1258519583 | error | Cannot read properties of undefined",
    "DONE",
  ])).toEqual({
    "714869495": {
      ms: 9179.5,
      frames: 1247,
      recorded_frames: 1247,
      worst_frame_ms: 826.5,
      short_frames: 4,
      load_ms: 1168.6,
    },
    "1201938491": {
      ms: 300012.3,
      frames: 300,
      recorded_frames: 510,
      worst_frame_ms: 1221.6,
      short_frames: 0,
      load_ms: 8287.2,
    },
    "1258519583": { error: "Cannot read properties of undefined" },
  });
});
