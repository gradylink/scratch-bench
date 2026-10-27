import fs from "node:fs";
import path from "node:path";
import { CACHE } from "../paths.ts";
import { COMPILER_VARIANTS } from "../variants.ts";
import { run } from "../webbundle.ts";
import { endOfDay } from "../backfill/schedule.ts";
import {
  compile,
  headlessCommand,
  REPO,
  windowCommand,
} from "./oscratchl-shared.ts";
import type { HistoricLaunch, HistorySpec, Pin, SuiteId } from "./types.ts";

const dir = () =>
  path.join(
    process.env.BENCH_BACKFILL_DIR ?? path.join(CACHE, "backfill"),
    "oscratchl",
  );

const repoUrl = () => process.env.OSCRATCHL_REPO ?? REPO;

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")}: ${err.trim()}`);
  }
  return out.trim();
};

let mirrored: { where: string; ready: Promise<string> } | undefined;
const mirror = (): Promise<string> => {
  const where = path.join(dir(), "mirror");
  if (mirrored?.where !== where) {
    mirrored = {
      where,
      ready: (async () => {
        if (!fs.existsSync(path.join(where, "HEAD"))) {
          fs.mkdirSync(dir(), { recursive: true });
          await git(dir(), "clone", "--quiet", "--bare", repoUrl(), where);
        } else {
          await git(
            where,
            "fetch",
            "--quiet",
            "origin",
            "+HEAD:refs/heads/bench-head",
          );
        }
        return where;
      })(),
    };
  }
  return mirrored.ready;
};

const resolve = async (date: string): Promise<Pin | null> => {
  const repo = await mirror();
  const ref =
    (await git(repo, "rev-parse", "--verify", "--quiet", "bench-head").catch(
        () => "",
      ))
      ? "bench-head"
      : "HEAD";
  const sha = await git(
    repo,
    "rev-list",
    "-1",
    `--before=${endOfDay(date)}`,
    ref,
  );
  return sha ? { parts: [], custom: { version: sha.slice(0, 7), sha } } : null;
};

const build = async (pin: Pin, suite: SuiteId): Promise<HistoricLaunch> => {
  const sha = pin.custom!.sha!;
  const out = path.join(dir(), sha);
  const bin = path.join(out, "oscratchl");
  // The runtime source stays beside the binary: `--compile` needs it to build each project.
  const runtimeSource = path.join(out, "src", "src");
  if (!fs.existsSync(bin) || !fs.existsSync(runtimeSource)) {
    const mirrorDir = await mirror();
    const src = path.join(out, "src");
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(src, { recursive: true });
    await run([
      "sh",
      "-c",
      `git -C '${mirrorDir}' archive ${sha} | tar -x -C '${src}'`,
    ], dir());
    await compile(src, bin);
    if (fs.existsSync(path.join(src, "fonts"))) {
      fs.cpSync(path.join(src, "fonts"), path.join(out, "fonts"), {
        recursive: true,
      });
    }
  }
  return {
    display: suite === "parity",
    command: (
      sb3,
      v,
    ) => (suite === "parity"
      ? windowCommand(bin, sb3, runtimeSource, v)
      : headlessCommand(bin, sb3, runtimeSource, v)),
  };
};

export const oscratchlHistory: HistorySpec = {
  variants: COMPILER_VARIANTS,
  since: { performance: "2026-10-25", parity: "2026-10-25" },
  custom: { resolve: (date) => resolve(date), build },
};
