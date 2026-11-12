import fs from "node:fs";
import path from "node:path";
import { endOfDay } from "../backfill/schedule.ts";
import { ADAPTERS, CACHE, ROOT, RUNTIME_DIR } from "../paths.ts";
import { run } from "../webbundle.ts";
import { replayEnv } from "./node-vm.ts";
import type { Command, HistoricLaunch, Pin, Runtime } from "./types.ts";

// forkphorus is a JavaScript compiler for Scratch projects (not a scratch-vm fork). It runs in a browser, so both
// suites go through runtimes/forkphorus.mjs in headless Chromium. It commits its build (phosphorus.dist.js).
const REPO = "https://github.com/forkphorus/forkphorus";
const LIVE = path.join(RUNTIME_DIR, "forkphorus", "src");
const historyDir = () =>
  path.join(
    process.env.BENCH_BACKFILL_DIR ?? path.join(CACHE, "backfill"),
    "forkphorus",
  );

const git = (cwd: string, ...args: string[]) => run(["git", ...args], cwd);
const gitOut = async (cwd: string, ...args: string[]): Promise<string> => {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")} failed`);
  }
  return out.trim();
};

const command = (dir: string, sb3: string): Command => ({
  cmd: ["node", path.join(ADAPTERS, "forkphorus.mjs"), dir, sb3],
  cwd: ROOT,
});

// Old checkouts may not have the committed build; make it with their own TypeScript setup.
const ensureBuilt = async (dir: string) => {
  if (fs.existsSync(path.join(dir, "phosphorus.dist.js"))) return;
  await run(["bun", "install", "--ignore-scripts"], dir);
  await run(["bun", "x", "tsc"], dir);
  if (!fs.existsSync(path.join(dir, "phosphorus.dist.js"))) {
    throw new Error("building forkphorus produced no phosphorus.dist.js");
  }
};

let mirror: Promise<string> | undefined;
const history = () =>
  mirror ??= (async () => {
    const where = path.join(historyDir(), "mirror");
    if (!fs.existsSync(path.join(where, "HEAD"))) {
      fs.mkdirSync(historyDir(), { recursive: true });
      await git(
        historyDir(),
        "clone",
        "--quiet",
        "--bare",
        "--filter=blob:none",
        REPO,
        where,
      );
    } else {
      await git(
        where,
        "fetch",
        "--quiet",
        "origin",
        "+refs/heads/*:refs/heads/*",
      );
    }
    return where;
  })().catch((e) => {
    // Let the next resolve try again rather than reuse this failure.
    mirror = undefined;
    throw e;
  });

let liveDir: string | undefined;

export const forkphorus: Runtime = {
  id: "forkphorus",
  name: "forkphorus",
  kind: "node",
  async setup({ offline }) {
    if (!fs.existsSync(path.join(LIVE, ".git"))) {
      if (offline) {
        throw new Error(
          "no cached forkphorus clone; run without --offline once",
        );
      }
      fs.mkdirSync(path.dirname(LIVE), { recursive: true });
      await git(
        path.dirname(LIVE),
        "clone",
        "--quiet",
        "--depth",
        "1",
        REPO,
        LIVE,
      );
    } else if (!offline) {
      await git(LIVE, "fetch", "--quiet", "--depth", "1", "origin");
      await git(LIVE, "reset", "--quiet", "--hard", "origin/HEAD");
    }
    await ensureBuilt(LIVE);
    liveDir = LIVE;
    const commit = await gitOut(LIVE, "rev-parse", "HEAD");
    return { version: commit.slice(0, 7), detail: { commit, repo: REPO } };
  },
  headless: { command: (sb3) => command(liveDir!, sb3) },
  gui: {
    command: (sb3) => command(liveDir!, sb3),
    replay: (sb3, r) => ({
      ...command(liveDir!, sb3),
      env: { ...(process.env as Record<string, string>), ...replayEnv(r) },
    }),
  },
  history: {
    since: { performance: "2025-08-01", parity: "2025-08-01" },
    custom: {
      async resolve(date): Promise<Pin | null> {
        const repo = await history();
        const sha = await gitOut(
          repo,
          "rev-list",
          "-1",
          "--first-parent",
          `--before=${endOfDay(date)}`,
          "HEAD",
        );
        return sha
          ? { parts: [], custom: { version: sha.slice(0, 7), sha } }
          : null;
      },
      async build(pin): Promise<HistoricLaunch> {
        const sha = pin.custom!.sha!;
        const dir = path.join(historyDir(), sha);
        if (!fs.existsSync(path.join(dir, "phosphorus.dist.js"))) {
          fs.rmSync(dir, { recursive: true, force: true });
          fs.mkdirSync(dir, { recursive: true });
          const repo = await history();
          await run([
            "bash",
            "-c",
            `set -o pipefail; git -C '${repo}' archive ${sha} | tar -x -C '${dir}'`,
          ], historyDir());
          await ensureBuilt(dir);
        }
        return { command: (sb3) => command(dir, sb3) };
      },
    },
  },
};
