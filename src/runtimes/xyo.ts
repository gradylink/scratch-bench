import fs from "node:fs";
import path from "node:path";
import { RUNTIME_DIR } from "../paths.ts";
import type { Runtime, SetupInfo, Variant } from "./types.ts";

// xyo-cpp: https://github.com/pnsk-lab/xyo-cpp
//
// A native (C++20 + LLVM ORC JIT) Scratch runtime with its own interpreter and
// AOT compiler, so there is no node adapter between the VM and the project: the
// binary runs the sb3 directly. The harness contract is the same as for the JS
// runtimes — the project appends its log lines to a list on the stage (here
// "output") and the launcher echoes new items to stdout — which `xyo run
// --print-list NAME` does natively, one line per step.
//
// Two options matter for comparability:
//   --fps 30    scratch-vm steps at 30fps and a non-warp loop iteration costs a
//               tick. Without pacing xyo would run thousands of ticks per
//               millisecond and the scheduler benchmarks (which count loop
//               passes per 100ms of wall time) would not be comparable.
//   XYO_JIT_MODE of the variant, so the JIT and the interpreter are measured as
//               two variants of one runtime, like the other VMs' compiler and
//               interpreter modes.
//
// By default the latest verified Linux release is downloaded. Set XYO_SOURCE=source
// to use the source checkout and CMake build instead, or XYO_BIN to use a local binary.

const REPO = process.env.XYO_REPO ?? "https://github.com/pnsk-lab/xyo-cpp.git";
const RELEASE_API =
  process.env.XYO_RELEASE_API ??
  "https://api.github.com/repos/pnsk-lab/xyo-cpp/releases/latest";
const CLONE_DIR = path.join(RUNTIME_DIR, "xyo-cpp");
const CACHE_DIR = path.join(RUNTIME_DIR, "xyo-build");
const RELEASE_DIR = path.join(RUNTIME_DIR, "xyo-release");
const AOT_DIR = path.join(RUNTIME_DIR, "xyo-aot");

const log = (s: string) => console.error(`[xyo-cpp] ${s}`);

const which = (bin: string): string | null => Bun.which(bin);

const spawnChecked = async (
  cmd: string[],
  cwd?: string,
): Promise<{ out: string; err: string }> => {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(
      `${cmd.join(" ")} failed (${code}):\n${
        (err || out).trim().split("\n").slice(-15).join("\n")
      }`,
    );
  }
  return { out, err };
};

const download = async (url: string): Promise<Uint8Array> => {
  const response = await fetch(url, {
    headers: { "User-Agent": "scratch-bench/xyo-cpp-runtime" },
  });
  if (!response.ok) {
    throw new Error(`download failed (${response.status}): ${url}`);
  }
  return new Uint8Array(await response.arrayBuffer());
};

const releaseBinary = async (offline: boolean): Promise<{
  binary: string;
  version: string;
  detail: Record<string, string>;
}> => {
  const archiveName = process.arch === "x64"
    ? "xyo-linux-x86_64.tar.gz"
    : null;
  if (!archiveName) {
    throw new Error(
      `no xyo-cpp release asset for Linux architecture "${process.arch}"`,
    );
  }

  const dir = path.join(RELEASE_DIR, archiveName.replace(/\.tar\.gz$/, ""));
  const bin = path.join(dir, "xyo");
  const marker = path.join(dir, ".verified");
  const cached = (): {
    binary: string;
    version: string;
    detail: Record<string, string>;
  } | null => {
    if (!fs.existsSync(bin) || !fs.existsSync(marker)) return null;
    return {
      binary: bin,
      version: fs.readFileSync(marker, "utf8").trim(),
      detail: { binary: bin, source: "GitHub release" },
    };
  };
  if (offline) {
    const result = cached();
    if (result) return result;
    throw new Error(
      `no cached xyo-cpp release at ${dir}; run once without --offline`,
    );
  }

  let release: {
    tag_name?: string;
    assets?: { name: string; browser_download_url: string }[];
  };
  try {
    release = JSON.parse(new TextDecoder().decode(await download(RELEASE_API)));
  } catch (e) {
    throw new Error(
      `could not read latest xyo-cpp release: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  const version = release.tag_name;
  const assets = release.assets ?? [];
  const archive = assets.find((x) => x.name === archiveName);
  const sums = assets.find((x) => x.name === "SHA256SUMS.txt");
  if (!version || !archive || !sums) {
    throw new Error(
      `latest xyo-cpp release is missing ${archiveName} or SHA256SUMS.txt`,
    );
  }
  const result = cached();
  if (result && result.version === version) return result;

  log(`downloading xyo-cpp ${version}`);
  const archiveBytes = await download(archive.browser_download_url);
  const sumsText = new TextDecoder().decode(await download(sums.browser_download_url));
  const expected = sumsText.match(
    new RegExp(`^([0-9a-fA-F]{64})\\s+\\*?${archiveName}$`, "m"),
  )?.[1]?.toLowerCase();
  if (!expected) {
    throw new Error(`SHA256SUMS.txt has no checksum for ${archiveName}`);
  }
  const actual = new Bun.CryptoHasher("sha256").update(archiveBytes).digest(
    "hex",
  );
  if (actual !== expected) {
    throw new Error(
      `checksum mismatch for ${archiveName}: expected ${expected}, got ${actual}`,
    );
  }

  const tmp = `${dir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const archivePath = path.join(tmp, archiveName);
  await Bun.write(archivePath, archiveBytes);
  await spawnChecked(["tar", "-xzf", archivePath, "-C", tmp]);
  if (!fs.existsSync(path.join(tmp, "xyo"))) {
    throw new Error(`release archive did not contain xyo: ${archiveName}`);
  }
  fs.rmSync(path.join(tmp, archiveName));
  fs.writeFileSync(path.join(tmp, ".verified"), version + "\n");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  return {
    binary: bin,
    version,
    detail: { binary: bin, source: "GitHub release", release: version },
  };
};

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) return "";
  return out;
};

/// A directory that looks like a checkout we can build.
const isCheckout = (dir: string): boolean =>
  fs.existsSync(path.join(dir, "CMakeLists.txt")) &&
  fs.existsSync(path.join(dir, "src", "shell", "main.cpp"));

/// Where the sources come from: an explicit checkout, the checkout this
/// repository happens to live in (the fork is developed inside xyo-cpp), or a
/// clone into the cache.
const resolveSource = async (offline: boolean): Promise<string> => {
  const explicit = process.env.XYO_SRC;
  if (explicit) {
    if (!isCheckout(explicit)) {
      throw new Error(`XYO_SRC=${explicit} is not an xyo-cpp checkout`);
    }
    return path.resolve(explicit);
  }
  const parent = path.resolve(import.meta.dir, "..", "..", "..");
  if (isCheckout(parent)) return parent;

  if (isCheckout(CLONE_DIR)) {
    if (!offline) {
      await git(CLONE_DIR, "fetch", "--depth", "1", "origin");
      const ref = process.env.XYO_REF;
      await git(
        CLONE_DIR,
        "checkout",
        ...(ref ? ["--detach", ref] : ["FETCH_HEAD"]),
      );
    }
    return CLONE_DIR;
  }
  if (offline) {
    throw new Error(
      `no cached xyo-cpp checkout at ${CLONE_DIR}; run once without --offline`,
    );
  }
  log(`cloning ${REPO}`);
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  await spawnChecked([
    "git",
    "clone",
    "--depth",
    "1",
    ...(process.env.XYO_REF ? ["--branch", process.env.XYO_REF] : []),
    REPO,
    CLONE_DIR,
  ]);
  return CLONE_DIR;
};

/// CMake out-of-tree build (one build directory per source tree, so a cache is
/// reused between runs and `ninja` makes the rebuild a no-op when nothing
/// changed).
const build = async (src: string): Promise<string> => {
  if (!which("cmake")) {
    throw new Error("cmake is not installed (xyo-cpp is built from source)");
  }
  const tag = new Bun.CryptoHasher("sha256").update(src).digest("hex").slice(
    0,
    8,
  );
  const dir = path.join(CACHE_DIR, tag);
  const bin = path.join(dir, "xyo");
  const sdl = process.env.XYO_SDL2 !== "0";
  fs.mkdirSync(dir, { recursive: true });
  log(`configuring ${src} -> ${dir}`);
  await spawnChecked([
    "cmake",
    "-S",
    src,
    "-B",
    dir,
    "-G",
    "Ninja",
    "-DCMAKE_BUILD_TYPE=Release",
    "-DXYO_JIT=ON",
    "-DXYO_BUILD_TESTS=OFF",
    `-DXYO_SDL2=${sdl ? "ON" : "OFF"}`,
  ]);
  log("building (ninja)");
  await spawnChecked([
    "cmake",
    "--build",
    dir,
    "--target",
    "xyo",
    "-j",
    String(Math.max(1, navigator.hardwareConcurrency || 4)),
  ]);
  if (!fs.existsSync(bin)) throw new Error(`the build produced no ${bin}`);
  return bin;
};

let binaryPath: string | undefined;

const binary = (): string => {
  if (!binaryPath) throw new Error("xyo-cpp was not set up");
  return binaryPath;
};

/// The AOT object for a suite build; `xyo aot --obj` is deterministic, so the
/// path is derived from the sb3 itself and the variant can reuse it.
const aotObject = (sb3: string): string => {
  const st = fs.statSync(sb3);
  return path.join(AOT_DIR, `${path.basename(sb3)}.${st.size}.o`);
};

const aotVariant: Variant = {
  id: "aot",
  name: "AOT",
  default: false,
  prepare(sb3: string): void {
    const out = aotObject(sb3);
    if (fs.existsSync(out)) return;
    fs.mkdirSync(AOT_DIR, { recursive: true });
    log(`aot: ${path.basename(sb3)} -> ${out}`);
    const proc = Bun.spawnSync([
      binary(),
      "aot",
      sb3,
      "--obj",
      out,
    ], {
      cwd: path.dirname(binary()),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      // Since the semantics remain the same even if we fall back (the JIT compiles everything), we do not treat projects that cannot be AOT-compiled as failures;
      // instead, we let them run as is.
      log(
        `aot failed (${proc.exitCode}): ${
          new TextDecoder().decode(proc.stderr).trim().split("\n").pop()
        }`,
      );
      fs.rmSync(out, { force: true });
    }
  },
};

export const xyoCpp: Runtime = {
  id: "xyo-cpp",
  name: "xyo-cpp",
  kind: "native",
  async setup({ offline }): Promise<SetupInfo> {
    let src: string | null = null;
    let version = "custom";
    const detail: Record<string, string> = {};

    const override = process.env.XYO_BIN;
    if (override) {
      if (!fs.existsSync(override)) {
        throw new Error(`XYO_BIN=${override} does not exist`);
      }
      binaryPath = path.resolve(override);
      detail.binary = binaryPath;
    } else if (process.env.XYO_SOURCE !== "source") {
      const release = await releaseBinary(offline);
      binaryPath = release.binary;
      version = release.version;
      Object.assign(detail, release.detail);
    } else {
      src = await resolveSource(offline);
      binaryPath = await build(src);
      const commit = (await git(src, "rev-parse", "HEAD")).trim();
      const dirty = (await git(
        src,
        "status",
        "--porcelain",
        "--untracked-files=no",
      )).trim() !== "";
      version = commit ? `${commit.slice(0, 7)}${dirty ? "-dirty" : ""}` : "unknown";
      detail.commit = commit || "unknown";
      detail.dirty = String(dirty);
      detail.src = src;
      detail.binary = binaryPath;
      detail.jit = "on";
      detail.build = "Release";
      detail.sdl2 = process.env.XYO_SDL2 === "0" ? "off" : "on";
    }
    detail.fps = process.env.XYO_FPS ?? "30";
    detail["print-list"] = "output";

    return {
      version,
      detail,
      variants: [
        {
          id: "hotspot",
          name: "JIT (hotspot)",
          default: true,
          env: { XYO_JIT_MODE: "hotspot" },
        },
        {
          id: "interpreter",
          name: "interpreter",
          default: false,
          env: { XYO_JIT_MODE: "off" },
        },
        {
          id: "eager",
          name: "JIT (eager)",
          default: false,
          env: { XYO_JIT_MODE: "eager" },
        },
        aotVariant,
      ],
    };
  },
  // `xyo play` runs the project in its own SDL2 window. The parity suite needs
  // a renderer (pen, touching, fencing, bounce), and that path is the same CPU
  // renderer either way, so a headless machine can use SDL's offscreen video
  // driver instead of Xvfb. `--list-limit 200000` matches Scratch (xyo defaults
  // to TurboWarp's unlimited lists) — the suite checks Scratch's list limit.
  gui: {
    command: (sb3, variant) => {
      const cmd = [binary(), "play", sb3, "--print-list", "output"];
      if (process.env.XYO_SCRATCH_LISTS !== "0") {
        cmd.push("--list-limit", "200000");
      }
      if (variant?.id === "aot") {
        const obj = aotObject(sb3);
        if (fs.existsSync(obj)) cmd.push("--aot", obj);
      }
      return {
        cmd,
        cwd: path.dirname(binary()),
        env: {
          ...(process.env as Record<string, string>),
          SDL_VIDEODRIVER: process.env.XYO_VIDEODRIVER ?? "offscreen",
          SDL_AUDIODRIVER: process.env.SDL_AUDIODRIVER ?? "dummy",
          XYO_EXIT_ON_DONE: "1",
        },
        projectLine: /^(.*)$/,
      };
    },
  },
  headless: {
    command: (sb3, variant) => {
      const fps = process.env.XYO_FPS ?? "30";
      const cmd = [binary(), "run", sb3, "--print-list", "output"];
      if (fps !== "0") cmd.push("--fps", fps);
      if (variant?.id === "aot") {
        const obj = aotObject(sb3);
        if (fs.existsSync(obj)) cmd.push("--aot", obj);
      }
      return {
        cmd,
        cwd: path.dirname(binary()),
        // xyo prints nothing but the list items when --print-list is given
        // (the load banner and the exit line go to stderr), and a run ends
        // with the suite's own DONE line.
        projectLine: /^(.*)$/,
      };
    },
  },
};
