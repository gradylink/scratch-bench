# Projects

Real Scratch projects, each with a recording of a person using it, replayed as a benchmark (the
`projects` suite).

- `manifest.json` lists the projects: id, title, author, and the sha256 of the `project.json` the
  recording belongs to.
- `recordings/<id>.json` is the recorded play: the frame rate, the number of frames, how many
  scheduler ticks ran in each frame (`passes`), and the inputs with the frame they happened on
  (green flag, mouse, keys, wheel, `ask` answers, slider changes, turbo).

The projects themselves aren't committed. Download them into `.cache/projects` with:

```sh
bun run fetch-projects            # all of them
bun run fetch-projects 1201938491 # just some
```

A project whose `project.json` no longer matches the manifest has been edited since it was recorded,
so it is skipped. Then run the suite. Only runtimes using the browser runner support it so far, except
MistWarp and 02engine, whose schedulers check the tick timer after a tick:

```sh
bun run bench --suite projects --runtime scratch,turbowarp
```

Rendering uses SwiftShader (software WebGL) by default, so every host draws the same way. With a GPU,
`BENCH_GPU=1` renders through Vulkan instead, which makes render-heavy projects many times faster:
all 132 replay in TurboWarp in about 16 minutes on an RTX 2070.

## How a replay works

`runtimes/chromium/index.html` (`replay`) loads each project, applies its TurboWarp settings where the
runtime has them, and steps it frame by frame. Each frame applies that frame's recorded inputs, then
runs exactly the recorded number of ticks, so every runtime runs the same ticks however fast it is.
The clock is virtual (one frame per step), Math.random is seeded and sound is off ("play sound until
done" returns at once), so timers and waits never depend on real time. A project stops after 5
minutes of real time (`BENCH_PROJECT_BUDGET_MS`); one stuck in a single frame for a minute longer is
reported as an error and the browser is restarted.

Each project reports the real time spent stepping, the frames it reached, its worst frame, the
frames that ran fewer ticks than recorded (the replay drifted from the recording), and its load time.

The projects are by their authors on scratch.mit.edu, shared under CC BY-SA 2.0.
