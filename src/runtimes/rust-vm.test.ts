import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const fixture = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-rust-vm-"));
  dirs.push(dir);
  const origin = path.join(dir, "origin");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(origin);
  fs.mkdirSync(bin);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: origin });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  const commit = (text: string) => {
    fs.writeFileSync(path.join(origin, "version"), text);
    git("add", ".");
    git("commit", "-qm", text);
    return git("rev-parse", "HEAD");
  };
  // Exercise real Git against a local origin; only Cargo is stubbed here.
  const cargoLog = path.join(dir, "cargo.log");
  fs.writeFileSync(path.join(bin, "cargo"), `#!/bin/sh
set -eu
echo "$*" >> "$CARGO_TEST_LOG"
if [ "\${CARGO_TEST_FAIL:-0}" = 1 ]; then echo "test build failure" >&2; exit 1; fi
while [ "$1" != "--target-dir" ]; do shift; done
shift
mkdir -p "$1/release"
touch "$1/release/scratch-bench-rust-vm"
`);
  fs.chmodSync(path.join(bin, "cargo"), 0o755);
  const cache = path.join(dir, "cache");
  const env = {
    ...process.env,
    RUSTVM_BINARY: "",
    RUSTVM_CACHE_DIR: cache,
    PATH: `${bin}:${process.env.PATH}`,
    CARGO_TEST_LOG: cargoLog,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.file://${origin}.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://github.com/flufiwarp/rust-vm.git",
  };
  const setup = async (offline = false, extra: Record<string, string> = {}) => {
    const proc = Bun.spawn([process.execPath, "-e", `
      import { rustVm } from ${JSON.stringify(path.join(import.meta.dir, "rust-vm.ts"))};
      const info = await rustVm.setup({ offline: ${offline}, gui: false });
      console.log(JSON.stringify({ info, command: rustVm.headless.command("/project.sb3"), gui: !!rustVm.gui }));
    `], { env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { out, err, code };
  };
  return { dir, cache, cargoLog, commit, setup, git };
};

test("rust-vm builds latest upstream, follows updates and supports offline setup", async () => {
  const f = fixture();
  const first = f.commit("first");
  const initial = await f.setup();
  expect(initial.code).toBe(0);
  const data = JSON.parse(initial.out);
  expect(data.info.detail.commit).toBe(first);
  expect(data.info.version).toBe(first.slice(0, 7));
  expect(data.command.cmd).toEqual([
    path.join(f.cache, "target/release/scratch-bench-rust-vm"), "/project.sb3",
  ]);
  expect(data.gui).toBe(false);
  const runnerMtime = fs.statSync(path.join(f.cache, "adapter/src/main.rs")).mtimeMs;

  const second = f.commit("second");
  const updated = await f.setup();
  expect(updated.code).toBe(0);
  expect(JSON.parse(updated.out).info.detail.commit).toBe(second);
  expect(fs.statSync(path.join(f.cache, "adapter/src/main.rs")).mtimeMs).toBe(runnerMtime);

  f.git("checkout", "-qb", "new-default");
  const third = f.commit("new default branch");
  const switched = await f.setup();
  expect(switched.code).toBe(0);
  expect(JSON.parse(switched.out).info.detail.commit).toBe(third);

  // No remote is reachable now: cached setup must still work without Git I/O.
  fs.renameSync(path.join(f.dir, "origin"), path.join(f.dir, "unavailable"));
  const offline = await f.setup(true);
  expect(offline.code).toBe(0);
  expect(JSON.parse(offline.out).info.detail.commit).toBe(third);
  expect(fs.readFileSync(f.cargoLog, "utf8").trim().split("\n").at(-1))
    .toContain("--offline");
});

test("rust-vm offline setup fails clearly without a cached clone", async () => {
  const result = await fixture().setup(true);
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("no cached rust-vm clone");
});

test("rust-vm accepts a custom runner without Git or Cargo", async () => {
  const f = fixture();
  const binary = path.join(f.dir, "custom-runner");
  fs.writeFileSync(binary, "");
  const result = await f.setup(true, { RUSTVM_BINARY: binary });
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out).info.version).toBe("custom");
  expect(JSON.parse(result.out).command.cmd[0]).toBe(binary);
  expect(fs.existsSync(f.cargoLog)).toBe(false);
  const missing = await f.setup(true, { RUSTVM_BINARY: `${binary}-missing` });
  expect(missing.code).not.toBe(0);
  expect(missing.err).toContain("does not exist");
});

test("rust-vm reports Cargo failures rather than using a stale runner", async () => {
  const f = fixture();
  f.commit("first");
  expect((await f.setup()).code).toBe(0);
  f.commit("second");
  const failed = await f.setup(false, { CARGO_TEST_FAIL: "1" });
  expect(failed.code).not.toBe(0);
  expect(failed.err).toContain("test build failure");
});
