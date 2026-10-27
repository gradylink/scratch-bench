import fs from "node:fs";
import path from "node:path";
import { RUNTIME_DIR } from "../paths.ts";
import { COMPILER_VARIANTS } from "../variants.ts";
import { run } from "../webbundle.ts";
import {
  compile,
  headlessCommand,
  REPO,
  windowCommand,
} from "./oscratchl-shared.ts";
import { oscratchlHistory } from "./oscratchl-history.ts";
import type { Runtime, SetupInfo } from "./types.ts";

const ROOT_DIR = path.join(RUNTIME_DIR, "oscratchl");
const NAME = "oscratchl";

let binary: string | undefined;
let runtimeSource: string | undefined;

const git = async (dir: string, ...args: string[]): Promise<string> => {
  const proc = Bun.spawn(["git", "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${err.trim()}`);
  }
  return out.trim();
};

const source = async (
  offline: boolean,
): Promise<{ dir: string; own: boolean }> => {
  if (process.env.OSCRATCHL_DIR) {
    return { dir: path.resolve(process.env.OSCRATCHL_DIR), own: true };
  }
  const dir = path.join(ROOT_DIR, "src");
  if (!fs.existsSync(path.join(dir, ".git"))) {
    if (offline) {
      throw new Error("no cached oscratchl clone; run without --offline once");
    }
    fs.mkdirSync(ROOT_DIR, { recursive: true });
    await run(["git", "clone", "--quiet", REPO, dir], ROOT_DIR);
  } else if (!offline) {
    await git(dir, "fetch", "--quiet", "origin");
    await git(dir, "reset", "--quiet", "--hard", "origin/HEAD");
  }
  return { dir, own: false };
};

export const oscratchl: Runtime = {
  id: "oscratchl",
  name: "oscratchl",
  kind: "native",
  history: oscratchlHistory,
  async setup({ offline }): Promise<SetupInfo> {
    if (process.env.OSCRATCHL_BINARY) {
      binary = path.resolve(process.env.OSCRATCHL_BINARY);
      runtimeSource = undefined;
      if (!fs.existsSync(binary)) {
        throw new Error(`OSCRATCHL_BINARY ${binary} does not exist`);
      }
      return { version: "custom", detail: { binary }, variants: COMPILER_VARIANTS };
    }

    const { dir, own } = await source(offline);
    const commit = await git(dir, "rev-parse", "HEAD");
    binary = own ? path.join(dir, NAME) : path.join(ROOT_DIR, "bin", NAME);
    runtimeSource = path.join(dir, "src");
    const stamp = `${binary}.commit`;
    const built = !fs.existsSync(binary)
      ? null
      : own
      ? commit
      : fs.existsSync(stamp)
      ? fs.readFileSync(stamp, "utf8").trim()
      : "";

    if (built === null || built !== commit) {
      fs.mkdirSync(path.dirname(binary), { recursive: true });
      await compile(dir, binary);
      if (!own) fs.writeFileSync(stamp, commit);
    }
    if (!own) {
      fs.rmSync(path.join(path.dirname(binary), "fonts"), {
        recursive: true,
        force: true,
      });
      fs.cpSync(
        path.join(dir, "fonts"),
        path.join(path.dirname(binary), "fonts"),
        { recursive: true },
      );
    }

    const binaryTime = fs.statSync(binary).mtimeMs;
    const commitTime =
      Number(await git(dir, "log", "-1", "--format=%ct", "HEAD")) * 1000;
    return {
      version: commit.slice(0, 7),
      variants: COMPILER_VARIANTS,
      detail: {
        commit,
        repo: REPO,
        built: new Date(binaryTime).toISOString(),
        ...(own && binaryTime < commitTime
          ? { warning: "binary is older than the source's latest commit" }
          : {}),
      },
    };
  },
  headless: {
    command: (sb3, v) => headlessCommand(binary!, sb3, runtimeSource, v),
  },
  gui: {
    display: true,
    command: (sb3, v) => windowCommand(binary!, sb3, runtimeSource, v),
  },
};
