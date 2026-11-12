import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

// runtimes/replay.js is a browser script; give it a window and load it.
(globalThis as any).window = globalThis;
new Function(fs.readFileSync(path.join(import.meta.dir, "../runtimes/replay.js"), "utf8"))();
const { stateHash } = (globalThis as any).BenchReplay as { stateHash: (targets: unknown[]) => string };

const sprite = (over: Record<string, unknown> = {}) => ({
  stage: false, original: true, name: "Cat", x: 10, y: -5, direction: 90, size: 100, costume: 0,
  visible: true, rotationStyle: "all around", draggable: false, layer: 1,
  effects: { ghost: 0 }, variables: [["score", 3]], lists: [["items", [1, "a"]]], ...over,
});
const stage = (over: Record<string, unknown> = {}) => ({
  stage: true, original: true, name: "Stage", costume: 0, effects: {}, variables: [["level", "1"]], lists: [], ...over,
});

test("the state hash is pinned, so a change to it is a change to projects/REPLAY.md", () => {
  expect(stateHash([stage(), sprite()])).toBe(stateHash([stage(), sprite()]));
  expect(stateHash([stage(), sprite()])).toMatchSnapshot();
});

test("it doesn't depend on how a runtime happens to keep a value", () => {
  const base = stateHash([stage(), sprite()]);
  // A number kept as text, or text kept as a number; rounding past 3 decimals; -0.
  expect(stateHash([stage({ variables: [["level", 1]] }), sprite({ variables: [["score", "3"]] })])).toBe(base);
  expect(stateHash([stage(), sprite({ x: 10.0001, y: -5.0004 })])).toBe(base);
  expect(stateHash([stage(), sprite({ effects: { ghost: -0, color: 0 } })])).toBe(base);
  // Order of targets, variables and lists.
  expect(stateHash([sprite(), stage()])).toBe(base);
  expect(stateHash([stage(), sprite({ variables: [["b", 1], ["a", 2]] })]))
    .toBe(stateHash([stage(), sprite({ variables: [["a", 2], ["b", 1]] })]));
  // The layer only by its order among the sprites.
  expect(stateHash([stage(), sprite({ layer: 7 })])).toBe(base);
});

test("it does change with the state", () => {
  const base = stateHash([stage(), sprite()]);
  expect(stateHash([stage(), sprite({ x: 11 })])).not.toBe(base);
  // Text that isn't a number written as JavaScript writes one stays text.
  expect(stateHash([stage(), sprite({ variables: [["score", "3.0"]] })])).not.toBe(base);
  // Two variables of one name are both kept.
  expect(stateHash([stage(), sprite({ variables: [["score", 3], ["score", 3]] })])).not.toBe(base);
  expect(stateHash([stage(), sprite(), sprite({ original: false })])).not.toBe(base);
  expect(stateHash([stage(), sprite({ lists: [["items", [1, "b"]]] })])).not.toBe(base);
});
