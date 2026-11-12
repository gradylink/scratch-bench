# Replay protocol

How a runtime replays a recording for the `projects` suite. It follows TurboWarp's
[pianola](https://github.com/TurboWarp/pianola) benchmark, where the recordings come from, so that
every runtime does the same work however fast it is, and a runtime that gets faster by computing
something different shows up.

A runtime supports the suite by implementing this. The browser runner (`runtimes/chromium/index.html`,
`replay`) implements it for every scratch-vm based runtime; a native runtime takes it on its command
line.

## Input

- The project file, as pinned in `manifest.json` (by its SHA-256).
- The recording, `recordings/<id>.json`:
  - `framerate`: the frame rate it was recorded at, and `frames`: how many frames to replay. Every
    recording here is 10 seconds long.
  - `passes[f]`: how many passes over the threads frame `f` made when it was recorded. A pass steps
    every running thread until it yields.
  - `inputs`: what happened, each with the `frame` it happened before:
    - `{"type": "greenFlag"}`, `{"type": "stop"}`, `{"type": "turbo", "on": true}`
    - `{"type": "key", "key": "ArrowLeft", "keyCode": 37, "down": true}`: `key` is the browser's
      `KeyboardEvent.key`.
    - `{"type": "mouse", "x": 12.5, "y": -40}`: the pointer moved, in stage coordinates (it can be
      off the stage). With `"down": true|false` and `"button": 0` it was pressed or released there.
    - `{"type": "wheel", "dx": 0, "dy": -100}`
    - `{"type": "answer", "text": "..."}`: the answer to the open `ask`.
    - `{"type": "variable", "target": null, "id": "...", "value": 5}`: a slider set a variable, on
      the stage (`target` null) or the sprite of that name.

## Each frame

For frame `f` from 0 to `frames - 1`:

1. The project's clock (`timer`, `days since 2000`, `current`, and the time `wait` and `glide` go by)
   reads `2025-01-01T12:00:00Z` plus `f` frame intervals (1000 / the recording's `framerate`). It
   doesn't move within a frame.
2. The inputs recorded for frame `f` happen, in order, as they would from a person (the pointer
   starts at the middle of the stage, 0, 0, until the first one moves it): key presses
   start key hats and hold the key; a press on a sprite starts its click hats; a draggable sprite
   is dragged once the pointer moves more than 3 units, or after 400 ms held; the wheel starts the
   up/down arrow key hats.
3. Exactly `passes[f]` passes run, whether or not the frame asks for a redraw, so every runtime does
   the same work (the recordings come from TurboWarp, and runtimes stop for redraws differently).
   Only a frame with no running threads left can stop sooner. A frame that makes a different
   number of passes than recorded counts as **drifted**. (The scratch-vm forks check the time
   before, after or every few passes; the browser runner counts and stops passes where every one of
   them checks for a redraw, before each pass.)
4. Warp mode (run without screen refresh) and waiting behave as on an infinitely fast machine:
   loops never stop for time, and a block waiting on time or a condition yields at once, since
   nothing it waits on can change within a frame. (TurboWarp's compiled code yields a warp-mode
   wait after 100 checks rather than at once, and the same way from a warp-mode `repeat until`
   whose condition reads the timer, which would otherwise never end on a clock that doesn't move.) A
   script that would never finish holds up its frame until the
   replay is cut (below).
5. Random numbers come from a seeded generator, the same sequence every run.
6. Sound is off: nothing plays, and `play sound until done` doesn't wait.

Scripts are compiled before the first frame, by runtimes that compile (TurboWarp and its forks
precompile, oscratchl and forkphorus compile as they load), so compiling is in no runtime's time.

Frames run back to back, as fast as the runtime can, but a replay may take no longer than the
recording did (the budget: `frames` at `framerate`, 10 seconds). Once that much real time has passed
since the first frame began (hashing included), it stops after the current frame and reports the
frames it got through. So the GPU's time and the browser's take frames from a runtime too; it is
still scored on script time, on frames another runtime also got through.

A frame still running 3 seconds after the budget is **cut**: the replay stops there and reports the
frames before it, with the hash `unfinished`, its checkpoints so far, and a **bound**: a checkpoint
at the frame it was cut in (one past the frames it reached) at the script time before that frame
plus 3 seconds. That frame began before the budget ran out and has run ever since, so the runtime
would have finished it, or any later frame, no sooner. Compared at a frame the reference got to
past it, the runtime does no worse than it deserves, rather than being left out, which would score
it only on the projects it can manage. A checkpoint past the frames reached is always a bound, and a
reference's bound is never used. (A frame held up by drawing rather than its scripts, the GPU
taking over 3 seconds, would have its bound counted as script time; in practice frames that long
are scripts.)

The runners need to know where each frame begins for that: the browser runners log
`[REPLAY] frame <f> <script ms> <draw ms> <drifted>` before each frame and `[REPLAY] frames end`
after the last; oscratchl's watchdog reads the same from the frame loop.

## Output

One line, then `DONE`:

    <id> | <script ms> | <draw ms> | <frame ms> | <frames>/<recorded frames> | <drifted> | <hash> | <checkpoints>
    DONE

or `<id> | error | <message>` then `DONE`. Native runtimes print each line on stdout prefixed with
`[PROJECT] `.

- **frame ms**: real time for all the frames, from the first to the end of the last, without
  hashing: everything it took to get through them. The budget counts this.
- **script ms**: of that, the runtime's own work: handling the frames' inputs (starting hats,
  compiling) and stepping them. This is the speed the suite scores. The rest is mostly the GPU,
  which in the browser runners is SwiftShader (software, the same for every scratch-vm runtime) and
  for a headless native runtime is nothing, so counting it would blur the runtimes' differences.
- **draw ms**: of that, drawing the stage (only when asked to, see below) and waiting, after every
  frame, for the GPU to finish what the frame queued (pen lines and the like). Waiting every frame
  puts that work in the frame that made it; otherwise it piles up and is paid for by whatever next
  reads back from the GPU, or never.
- **checkpoints**: at frames 1, 2, 3, 5, 8, 13, 20, 30, 50, 80, 120, 200, 300, 500 and 800 (those
  reached) and at the last frame, the script time so far and the project's state then (below), as
  `frame:ms:state` separated by commas, and a cut replay's bound as `frame:ms`. A runtime is
  compared with the reference on the furthest checkpoint both reached, so on exactly the same
  frames, or through its bound; and only as far as its state agreed with the reference's.
- **hash**: the state at the last frame (or `unfinished`).

## State

So that a runtime that gets faster by computing something else shows up, the state at each
checkpoint is hashed the same way in every runtime, and a runtime is compared with the reference
(TurboWarp) only on the frames up to the last checkpoint at which their states agreed, and only if
that is frame 30 or later (the first frames are mostly a project setting up). A runtime whose state
agreed for fewer isn't compared on that project: whatever it was doing, it wasn't running it. Every
runner hashes the state this way (`BenchReplay.stateHash` in `runtimes/replay.js`, and
`hashState` in oscratchl's `src/io/replay.osl`; `src/replay-state.test.ts` pins an example):

- Each target (the stage, every sprite and every clone) is a **record**: fields joined by U+001F.
  - The stage: `stage`, `Stage`, then the common fields.
  - A sprite or clone: `sprite` (the original) or `clone`, its sprite's name, x, y, direction,
    size, `true`/`false` for visible, its rotation style (`all around`, `left-right` or `don't
    rotate`), `true`/`false` for draggable, and its place among the sprites and clones back to front
    (0 at the back), then the common fields.
  - The common fields: the costume's index (from 0); the color, fisheye, whirl, pixelate, mosaic,
    brightness and ghost effects, in that order; one field `name=value` for each variable; then one
    field `name#length#items` for each list, its items joined by U+001E (a list of over 10,000 items
    by 1000 of them, item `floor(i * (length / 1000))` for each i from 0). Variables, and then lists,
    are sorted by those fields' text, by code point. Two variables of one name are two fields.
- A **number** is rounded to 3 decimals (as `Math.round(n * 1000) / 1000`, unless its size is 1e15
  or more) and written as JavaScript writes numbers (`String(n)`; `-0` as `0`). A **value** is
  written as that if it is a number, or text that is a number written that way (`"10"`, not
  `"10.0"` or `" 10"`): runtimes keep the same value as either. Other text is itself; `true` and
  `false` are themselves.
- The stage's record comes first, then the others sorted by their text, by code point, all joined by
  U+001D. The state is FNV-1a (32-bit) of that text's UTF-8 bytes, as 8 lowercase hex digits.

`state-check/` has a project to check a runtime's state against: replayed with its
`recording.json` (`--replay-id 1`), it sets numbers past 1e21, -0, NaN and Infinity, text that
looks like a number and text that isn't ASCII, two variables of one name, a list of 10,001 items, a
clone, an effect, a size its costume clamps, a direction and a rotation style. Every checkpoint's
state is `bcd18494` in TurboWarp, Scratch and oscratchl.

For their random numbers to agree, a runtime's `pick random` and the like draw on the same
generator, seeded the same way, in the order the project asks for them (sfc32, as `BenchReplay`
seeds it, with `seed(1)` before the first frame); scratch-vm's own ids draw on another, so creating
a clone doesn't move the project's numbers.

The stage needn't be drawn: nothing a project computes depends on drawing it (pen, touching and
touching color work without it), and in software WebGL it costs more than the frames. The browser
runners draw it only with `BENCH_REPLAY_DRAW=1`.

## Command line

A native runtime replays with:

    <runtime> <project.sb3> --replay <recording.json> --replay-id <id> --replay-budget <ms>

where the budget is the recording's length in milliseconds.
