import fs from "node:fs";
import path from "node:path";
import { BUILD_DIR, ROOT } from "./paths.ts";
import { fetchProjects } from "./fetch-projects.ts";
import { manifest, PROJECT_FILES, type ReplayProject, replayProjects } from "./projects.ts";
import { type Suite, suiteSourceDir } from "./suites.ts";

export interface Built {
  /** The sb3, or for the projects suite the folder of downloaded projects. */
  sb3: string;
  hash: string;
  /** The projects suite's projects, each run on its own. */
  projects?: ReplayProject[];
  /** A run limit (per project) that overrides a shorter --timeout. */
  timeoutMs?: number;
}

export interface BuildOptions {
  offline?: boolean;
  log?: (line: string) => void;
}

const fractch = async (...args: string[]): Promise<string> => {
  const local = path.join(ROOT, "node_modules/.bin/fractch");
  const bin = fs.existsSync(local) ? local : Bun.which("fractch") ??
    path.join(process.env.HOME ?? "", ".cache/.bun/bin/fractch");
  const proc = Bun.spawn([bin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 120_000);
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);
  if (code !== 0) {
    throw new Error(
      `fractch ${args.join(" ")} failed (${code}):\n${err || out}`,
    );
  }
  return out + err;
};

function* walk(dir: string): Generator<string> {
  for (
    const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )
  ) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const hashSource = (dir: string): string => {
  const h = new Bun.CryptoHasher("sha256");
  for (const file of walk(dir)) {
    h.update(path.relative(dir, file));
    h.update(fs.readFileSync(file));
  }
  return h.digest("hex").slice(0, 16);
};

export const buildSuite = async (suite: Suite, o: BuildOptions = {}): Promise<Built> => {
  const dir = suiteSourceDir(suite);
  if (!fs.existsSync(dir)) {
    throw new Error(
      `${suite.source} does not exist${
        suite.id === "parity" ? " (git submodule update --init)" : ""
      }`,
    );
  }
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  if (suite.id === "projects") {
    if (!o.offline) await fetchProjects(manifest(), (line) => o.log?.(`  ${line}`));
    const projects = replayProjects();
    if (!projects.length) {
      throw new Error("none of the projects are downloaded (bun run fetch-projects)");
    }
    const h = new Bun.CryptoHasher("sha256")
      .update(hashSource(dir))
      .update(fs.readFileSync(path.join(ROOT, "src/projects.ts")));
    // The replay code is the suite as much as the recordings are.
    for (
      const file of [
        "runtimes/replay.js",
        "runtimes/chromium/index.html",
        "runtimes/chromium-vm.mjs",
        "runtimes/forkphorus.mjs",
        "runtimes/replay-runner.mjs",
        "runtimes/forkphorus/bench.html",
      ]
    ) h.update(fs.readFileSync(path.join(ROOT, file)));
    for (const p of projects) h.update(p.id);
    return {
      sb3: PROJECT_FILES,
      hash: h.digest("hex").slice(0, 16),
      projects,
      // A replay stops itself at its recording's length, and the runner gives up on a frame that
      // doesn't end soon after; this leaves time to start the runtime and load the project.
      // Loading (the browser, a project of up to 13 MB, its costumes) takes what it takes; the
      // replay itself is cut 3 s after its budget.
      timeoutMs: Math.max(...projects.map((p) => p.durationMs)) + 140_000,
    };
  }
  const sb3 = path.join(BUILD_DIR, `${suite.id}.sb3`);
  await fractch("check", dir);
  await fractch("to", sb3, "from", dir);
  return { sb3, hash: hashSource(dir) };
};
