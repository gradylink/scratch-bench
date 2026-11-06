# Rust VM runner

`bun run bench --runtime rust-vm --suite performance --runs 3`

Requires Cargo/Rust (stable, with edition 2024 support), Git and the normal
benchmark dependencies. Docker includes the toolchain and a release build.
Online setup fetches the latest default-branch commit from
<https://github.com/flufiwarp/rust-vm> and builds this runner against it.
`--offline` reuses the checkout and Cargo dependencies without network access.

Upstream is a library: its bundled examples embed their own projects. This
runner instead loads the supplied `.sb3` and streams the stage's `output` list
as `[PROJECT]` lines. Like upstream's benchmark example, it uses unthrottled
ticks and real elapsed time, not a simulated clock. Scheduler scores therefore
reflect upstream's unpaced scheduler, not a 30fps display loop. Diagnostic logs
are disabled. Graphical parity is skipped because upstream has no renderer.

- `RUSTVM_CACHE_DIR`: source/build directory (default `.cache/runtimes/rust-vm`).
  Docker uses `/opt/rust-vm` so existing `/app/.cache` volumes cannot hide the
  prebuilt runner. The container's `node` user can update both it and Cargo.
- `RUSTVM_BINARY`: use an already-built **runner** with the same `.sb3`/stdout
  contract, bypassing Git and Cargo.

`docker compose build --pull bench` refreshes the image. Docker's Git source
resolves upstream HEAD on each build, so upstream updates invalidate the build
cache without needing `--no-cache`. Normal online benchmark setup also checks
upstream HEAD and recompiles whenever needed.
