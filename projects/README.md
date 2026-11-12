# Projects

Real Scratch projects, each with a recording of a person using it, replayed as a benchmark (the
`projects` suite). The projects and recordings come from TurboWarp's
[pianola](https://github.com/TurboWarp/pianola) benchmark corpus; this suite uses 12 of them, the first
10 seconds of each:

- emulators: a Game Boy, a NES and a BBC Micro;
- simulations: Navier Stokes, Particle Lenia, the Game of Life and flow-field pathfinding;
- 3D: a renderer and an OBJ importer;
- games: Goopy, Bloons TD and Doom.

`manifest.json` lists them: id, title, author, and the SHA-256 of the project file the recording was
made with. `recordings/<id>.json` is the recorded play: its frame rate, how many passes the scheduler
made in each frame, and the inputs with the frame they happened before.

The project files aren't committed. The suite downloads them when it builds (not with `--offline`),
or `bun run fetch-projects` does, from the pinned copies pianola keeps
(`blobs.turbowarp.xyz/benchmarks/v1/<sha256>.sb3`), and checks each against its hash.

```sh
bun run bench --suite projects
```

## How a replay works

[REPLAY.md](REPLAY.md) is the protocol. In short, the project runs frame by frame, as fast as it can,
and each frame applies the inputs recorded for it and makes exactly the passes over the threads the
recording made, so every runtime does the same work. Time is a virtual clock that moves one frame per
frame, random numbers are seeded, sound is off, and waiting or running without screen refresh behaves
as on an infinitely fast machine. The stage isn't drawn (`BENCH_REPLAY_DRAW=1` draws it): nothing a
project computes depends on that, and in software WebGL it costs more than the frames.

Each replay reports:

- **script time**, the runtime's own work for the frames (handling the inputs and stepping them), at
  checkpoints through the replay;
- frame time, the real time it took to get through the frames (what the budget counts), and of it
  drawing time (the GPU finishing each frame's pen work and the like). These aren't scored: the
  GPU is SwiftShader, software and the same for every scratch-vm runtime, and a headless native
  runtime has none;
- the frames it got through: a replay may take no longer than the recording did, 10 seconds, so a
  runtime that can't keep up gets through fewer. A frame still running 3 seconds after that is cut,
  and the runtime is compared at TurboWarp's furthest frame as if it had finished that frame then:
  a bound it would only have done worse than, so a runtime too slow to finish a frame still counts
  as slow;
- frames that made a different number of passes than recorded (**drifted**): those did different
  work, and a replay with more than 1% of them isn't scored;
- the project's state at each checkpoint, hashed the same way in every runtime (REPLAY.md,
  "State"). A runtime is compared with TurboWarp only on the frames up to where their states last
  agreed: past that it was computing something else (a feature it lacks, a setting it ignores),
  and its time says nothing about running the project. One whose state stopped agreeing before
  frame 30 isn't compared on that project.

Each project is replayed 3 times (`--project-runs`) and the medians kept; if any of the 3 fails, so
does the project. The replays go in rounds: each round replays every project in every runtime, the
runtimes one after another for each project (moving along a place each project and each round), so
anything else
the machine does meanwhile falls on all of them about alike rather than on one, and least of all
on TurboWarp alone, which every runtime is measured against. A run should still have the machine
to itself: on a busy one a runtime's single replays vary by a third or more.

A runtime's speed on a project is TurboWarp's script time over its own at the furthest checkpoint
both reached, in the same run, so they are always compared on exactly the same frames: 0.5 is half as
fast as TurboWarp. There is no other reference: a project TurboWarp couldn't replay isn't scored.

A runtime's projects score is the geometric mean of its speeds times TurboWarp's own speed over all
the run's projects (the geometric mean of its frames per millisecond of script time on each), so it
is absolute like the benchmarks' and a change in TurboWarp shows in its score too. In the overall
score each project counts as much as two benchmarks of average weight. Projects a runtime failed to
replay (an error, not slowness) are left out of its projects score, which then changes only by how
fast it was on them, not by how heavy they are. A runtime with none (one that can't replay) has no
total in a run that scored projects, since it couldn't be compared with the others; the site only
compares totals between runs alike, with projects or without.

Runtimes take part when their launcher can replay (`replay` in `src/runtimes/types.ts`): every
scratch-vm based runtime through the browser runner (`runtimes/chromium/index.html`), forkphorus
through its own page (`runtimes/forkphorus/bench.html`, which patches its frame loop as it serves it),
and oscratchl builds that have `--replay`. Any other native runtime takes part by implementing
`--replay` (REPLAY.md); the rest are skipped.

A run whose biggest process grows past 6 GB (`BENCH_MEMORY_LIMIT_MB`) is stopped and reported as an
error, so a runtime that leaks can't take the machine down with it.

Projects that wait for real time to pass within a frame can't be replayed this way, since time
stands still within a frame: Linux on a RISC-V emulator (pianola's corpus has it) runs each frame
until the clock shows 50 ms have passed, so no runtime gets past its first frame.

The projects are by their authors on scratch.mit.edu, shared under CC BY-SA 2.0.
