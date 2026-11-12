// What every browser runner's replay shares (projects/REPLAY.md). Loaded as a classic script, before
// the runtime's own scripts, so they only ever see the patched Date and Math.random.
// scratch-vm's ids draw on this rather than Math.random in a replay (separateIds,
// replay-runner.mjs): a stream of their own, so they don't move the project's random numbers.
window.__benchIdRandom = (() => {
  let a = 0x2545f491, b = 0x9e3779b9, c = 0x243f6a88, d = 7;
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
})();

window.BenchReplay = (() => {
  // Date is a virtual clock the replay moves one frame interval per frame; within a frame it stands
  // still. performance.now() is left alone for the measurements.
  const RealDate = Date;
  let virtualNow = 0;
  class VirtualDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(virtualNow);
      else super(...args);
    }
    static now() {
      return virtualNow;
    }
  }
  // Math.random is sfc32, seeded.
  let a, b, c, d;
  const random = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  const seed = (s) => {
    a = 0x9e3779b9; b = 0x243f6a88; c = 0xb7e15162; d = s >>> 0;
    for (let i = 0; i < 16; i++) random();
  };


  // setTimeout on the virtual clock, while the frames run (virtualTimers): scratch-vm ends a
  // `say for secs` on a timeout, which in real time would end after however many frames fit in it.
  const timers = new Map();
  let nextTimer = 1 << 30;
  let real = null;

  // The state hash (projects/REPLAY.md, "State"): the same in every runner, so a runtime's state can
  // be checked against the reference's whatever it is written in.
  const EFFECTS = ["color", "fisheye", "whirl", "pixelate", "mosaic", "brightness", "ghost"];
  const LONG_LIST = 10_000;
  const LIST_SAMPLES = 1000;
  const number = (n) => {
    if (!Number.isFinite(n)) return String(n);
    const r = Math.abs(n) < 1e15 ? Math.round(n * 1000) / 1000 : n;
    return Object.is(r, -0) ? "0" : String(r);
  };
  // A value as text: numbers to 3 decimals, and text that is a number written as a number would be
  // ("10", not "10.0" or " 10") as that number, since runtimes keep the same value as either.
  const value = (v) =>
    typeof v === "number" ? number(v)
    : typeof v === "string" ? (v !== "" && String(Number(v)) === v ? number(Number(v)) : v)
    : String(v);
  const items = (list) => {
    if (list.length <= LONG_LIST) return list.map(value);
    const step = list.length / LIST_SAMPLES;
    return Array.from({ length: LIST_SAMPLES }, (_, i) => value(list[Math.floor(i * step)]));
  };
  // Sorted by code point (as their UTF-8 bytes sort, the order a native runtime has to hand), not
  // by UTF-16 code unit as JavaScript sorts.
  const byCodePoint = (a, b) => {
    const x = [...a];
    const y = [...b];
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const d = x[i].codePointAt(0) - y[i].codePointAt(0);
      if (d) return d;
    }
    return x.length - y.length;
  };
  const utf8 = new TextEncoder();
  const fnv1aBytes = (text) => {
    let h = 0x811c9dc5;
    for (const b of utf8.encode(text)) {
      h ^= b;
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  };

  // MessageChannel instead of setTimeout(0), which gets clamped to 4 ms after a few nested calls.
  const channel = new MessageChannel();
  const queue = [];
  channel.port1.onmessage = () => queue.shift()();

  return {
    EPOCH: RealDate.UTC(2025, 0, 1, 12, 0, 0),
    /**
     * The frames at which the script time so far is reported, so a runtime that didn't get through
     * the whole recording can be compared with another on exactly the frames it did.
     */
    CHECKPOINTS: [1, 2, 3, 5, 8, 13, 20, 30, 50, 80, 120, 200, 300, 500, 800],
    /** Scaffolding (TurboWarp's player) starts dragging a sprite held this long without moving. */
    DRAG_HOLD_MS: 400,
    DRAG_DISTANCE: 3,
    install() {
      window.Date = VirtualDate;
      Math.random = random;
      seed(1);
      virtualNow = this.EPOCH;
    },
    setTime: (ms) => (virtualNow = ms),
    /** Puts setTimeout on the virtual clock (true), or back (false). */
    virtualTimers(on) {
      if (on && !real) {
        real = { setTimeout: window.setTimeout, clearTimeout: window.clearTimeout };
        window.setTimeout = (fn, delay = 0, ...args) => {
          const id = nextTimer++;
          timers.set(id, { fn, args, start: virtualNow, delay: Math.max(0, Number(delay) || 0) });
          return id;
        };
        window.clearTimeout = (id) => {
          if (!timers.delete(id)) real.clearTimeout.call(window, id);
        };
      } else if (!on && real) {
        Object.assign(window, real);
        real = null;
      }
    },
    /**
     * Runs the virtual timeouts that are due: those for which the time since they were set is no
     * longer less than their delay, the test scratch-vm's own timers make. Returns whether any ran.
     */
    runTimers() {
      let ran = false;
      for (const [id, t] of [...timers]) {
        if (virtualNow - t.start < t.delay) continue;
        timers.delete(id);
        typeof t.fn === "function" ? t.fn(...t.args) : null;
        ran = true;
      }
      return ran;
    },
    seed,
    yieldToEventLoop: () => new Promise((resolve) => {
      queue.push(resolve);
      channel.port2.postMessage(null);
    }),
    /**
     * Tells the runner how far the replay has got, at each checkpoint, so that if a frame never ends
     * it can still report the frames before it.
     */
    report: (r) =>
      console.log(`[REPLAY] checkpoint ${r.frame} ${r.frameMs} ${r.scriptMs} ${r.drawMs} ${r.drifted} ${r.state}`),
    /**
     * The hash of a project's state, from its targets as each runner reads them:
     * { stage, original, name, x, y, direction, size, costume (from 0), visible, rotationStyle
     * ("all around", "left-right" or "don't rotate"), draggable, layer (any number ordering the
     * sprites back to front), effects: { name: value }, variables: [[name, value]],
     * lists: [[name, items]] } (pairs, as a project can have two variables of one name).
     * projects/REPLAY.md defines it.
     */
    stateHash(targets) {
      const sprites = targets.filter((t) => !t.stage).sort((a, b) => a.layer - b.layer);
      const rank = new Map(sprites.map((t, i) => [t, i]));
      const record = (t) => {
        const named = (pairs, f) => (pairs ?? []).map(([k, v]) => f(k, v)).sort(byCodePoint);
        return [
          t.stage ? "stage" : t.original ? "sprite" : "clone",
          t.name,
          ...(t.stage ? [] : [number(t.x), number(t.y), number(t.direction), number(t.size), String(t.visible),
            t.rotationStyle, String(t.draggable), String(rank.get(t))]),
          String(t.costume),
          ...EFFECTS.map((e) => number(t.effects?.[e] ?? 0)),
          ...named(t.variables, (k, v) => `${k}=${value(v)}`),
          ...named(t.lists, (k, l) => `${k}#${l.length}#${items(l).join("\x1e")}`),
        ].join("\x1f");
      };
      const records = targets.map(record);
      const stage = records.filter((r) => r.startsWith("stage\x1f"));
      const text = [...stage, ...records.filter((r) => !r.startsWith("stage\x1f")).sort(byCodePoint)].join("\x1d");
      // BENCH_STATE_DUMP: the first state's text, to compare runners' by eye.
      if (window.__dumpState) {
        window.__dumpState = false;
        console.log(`[REPLAY] state ${JSON.stringify(text)}`);
      }
      return fnv1aBytes(text);
    },
    /** Tells the runner a frame is starting, with the script time and drift before it. */
    started: (r) => console.log(`[REPLAY] frame ${r.frame} ${r.scriptMs} ${r.drawMs} ${r.drifted}`),
    /** The result line (projects/REPLAY.md). */
    line: (id, r) => {
      const ms = (x) => Math.round(x * 10) / 10;
      const marks = Object.entries(r.checkpoints).map(([f, t]) => `${f}:${ms(t)}:${r.states[f]}`).join(",");
      return `${id} | ${ms(r.scriptMs)} | ${ms(r.drawMs)} | ${ms(r.frameMs)} | ${r.frames}/${r.recorded} | ${r.drifted} | ${r.states[r.frames]} | ${marks}`;
    },
  };
})();
