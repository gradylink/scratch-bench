import fs from "node:fs";
import path from "node:path";
import { ADAPTERS, RUNTIME_DIR } from "../paths.ts";
import { run } from "../webbundle.ts";
import type { Runtime, SetupInfo } from "./types.ts";

const REPO = "https://github.com/flufiwarp/rust-vm.git";
let binary: string | undefined;

const git = (args: string[], cwd: string) => run(["git", ...args], cwd);

export const rustVm: Runtime = {
  id: "rust-vm",
  name: "Rust VM",
  kind: "native",
  async setup({ offline }): Promise<SetupInfo> {
    binary = undefined;
    if (process.env.RUSTVM_BINARY) {
      const custom = path.resolve(process.env.RUSTVM_BINARY);
      if (!fs.existsSync(custom)) {
        throw new Error(`RUSTVM_BINARY ${custom} does not exist`);
      }
      binary = custom;
      return { version: "custom", detail: { binary } };
    }

    const root = path.resolve(
      process.env.RUSTVM_CACHE_DIR ?? path.join(RUNTIME_DIR, "rust-vm"),
    );
    const source = path.join(root, "src");
    const adapter = path.join(root, "adapter");
    const target = path.join(root, "target");
    fs.mkdirSync(root, { recursive: true });
    if (!fs.existsSync(path.join(source, ".git"))) {
      if (offline) {
        throw new Error("no cached rust-vm clone; run without --offline once");
      }
      await git(["clone", "--quiet", "--depth", "1", REPO, source], root);
    } else if (!offline) {
      // Fetch HEAD explicitly so an upstream default-branch change is followed too.
      await git(["fetch", "--quiet", "--depth", "1", "origin", "HEAD"], source);
      await git(["checkout", "--quiet", "--detach", "FETCH_HEAD"], source);
    }
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: source,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (head.exitCode !== 0) throw new Error(`cannot read rust-vm commit: ${head.stderr}`);
    const commit = head.stdout.toString().trim();

    for (const file of ["Cargo.toml", "src/main.rs"]) {
      const contents = fs.readFileSync(path.join(ADAPTERS, "rust-vm", file));
      const dest = path.join(adapter, file);
      if (!fs.existsSync(dest) || !fs.readFileSync(dest).equals(contents)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, contents);
      }
    }
    // Always ask Cargo to check freshness: adapter edits also need a rebuild,
    // even when upstream's commit hasn't changed. --offline forbids registry I/O.
    await run([
      "cargo", "build", "--release", "--target-dir", target,
      ...(offline ? ["--offline"] : []),
    ], adapter);
    const built = path.join(target, "release", "scratch-bench-rust-vm");
    if (!fs.existsSync(built)) throw new Error(`rust-vm build did not produce ${built}`);
    binary = built;
    return {
      version: commit.slice(0, 7),
      detail: { commit, repo: REPO, binary, scheduler: "unthrottled", clock: "wall" },
    };
  },
  headless: {
    command(sb3) {
      if (!binary) throw new Error("Rust VM was not set up");
      return { cmd: [binary, sb3], cwd: path.dirname(binary) };
    },
  },
};
