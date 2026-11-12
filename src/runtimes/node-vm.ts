import path from "node:path";
import { ADAPTERS, ROOT } from "../paths.ts";
import { ensureWebBundle, type WebPart, type WebRecipe } from "../webbundle.ts";
import type { HistorySpec, Replay, Runtime, Variant } from "./types.ts";

export type NodeVmId =
  | "scratch"
  | "turbowarp"
  | "mistwarp"
  | "nitrobolt"
  | "penguinmod"
  | "gandi"
  | "penguinmod-port"
  | "clipcc"
  | "snailide"
  | "electramod"
  | "02engine"
  | "codetorch";

const PARTS = ["vm", "render", "audio", "storage", "svg-renderer"];
const SHARES: Partial<Record<NodeVmId, NodeVmId>> = {
  snailide: "penguinmod",
  electramod: "penguinmod",
};

const headOf = async (repo: string): Promise<string | null> => {
  const proc = Bun.spawn(
    ["git", "ls-remote", `https://github.com/${repo}`, "HEAD"],
    { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
  );
  const out = await new Response(proc.stdout).text();
  return (await proc.exited) === 0 ? out.split(/\s/)[0] || null : null;
};

const trackLatest = async (id: NodeVmId): Promise<void> => {
  const pkg = await Bun.file(path.join(ROOT, "package.json")).json();
  const prefixes = [id, SHARES[id]].filter((x): x is NodeVmId => !!x);
  const moves: string[] = [];
  for (const prefix of prefixes) {
    for (const part of PARTS) {
      const dep = `${prefix}-${part}`;
      const spec = String(pkg.dependencies?.[dep] ?? "");
      if (!spec.startsWith("github:")) continue;
      const [repo, pinned] = spec.slice("github:".length).split("#");
      const head = await headOf(repo!);
      if (head && head !== pinned) moves.push(`${dep}@github:${repo}#${head}`);
    }
  }
  if (!moves.length) return;
  const proc = Bun.spawn(["bun", "add", ...moves], {
    cwd: ROOT,
    stdout: "ignore",
    stderr: "pipe",
    stdin: "ignore",
  });
  const err = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) {
    console.error(
      `  ${id}: could not move to the latest commits, keeping the pins: ${
        err.trim().split("\n").at(-1)
      }`,
    );
  }
};

/** How the browser runners (chromium-vm.mjs, forkphorus.mjs) are told to replay. */
export const replayEnv = (r: Replay): Record<string, string> => ({
  BENCH_RECORDING: r.recording,
  BENCH_REPLAY_ID: r.id,
  BENCH_REPLAY_BUDGET_MS: String(r.budgetMs),
});

export const nodeVmRuntime = (
  id: NodeVmId,
  name: string,
  describe: () => Promise<{ version: string; detail?: Record<string, string> }>,
  { gui = true, web, history, variants }: {
    gui?: boolean;
    variants?: Variant[];
    web?: () => Promise<WebRecipe>;
    history?: HistorySpec;
  } = {},
): Runtime => {
  return {
    id,
    name,
    kind: "node",
    history,
    setup: async (opts) => {
      if (!opts.offline) await trackLatest(id);
      const described = await describe();
      const info = variants ? { ...described, variants } : described;
      if (web && opts.gui) await ensureWebBundle(await web());
      return info;
    },
    headless: {
      command: (sb3) => ({
        cmd: ["node", path.join(ADAPTERS, "node-vm.mjs"), id, sb3],
        cwd: ROOT,
      }),
    },
    gui: gui
      ? {
        command: (sb3) => ({
          cmd: ["node", path.join(ADAPTERS, "chromium-vm.mjs"), id, sb3],
          cwd: ROOT,
        }),
        replay: (sb3, r) => ({
          cmd: ["node", path.join(ADAPTERS, "chromium-vm.mjs"), id, sb3],
          cwd: ROOT,
          env: { ...(process.env as Record<string, string>), ...replayEnv(r) },
        }),
      }
      : undefined,
  };
};

export const packageVersion = async (pkg: string): Promise<string> => {
  const json = await Bun.file(
    path.join(ROOT, "node_modules", pkg, "package.json"),
  ).json();
  return json.version as string;
};

export const gitPinnedVersion = async (dep: string) => {
  const pkg = await Bun.file(path.join(ROOT, "package.json")).json();
  const commit = String(pkg.dependencies[dep]).split("#")[1] ?? "unknown";
  return {
    version: `${await packageVersion(dep)}+${commit.slice(0, 7)}`,
    commit,
  };
};

export const forkStack = (
  id: string,
  prebuilt: { svg?: boolean; storage?: boolean } = {},
): WebRecipe => ({
  id,
  parts: [
    { name: "vm", dep: `${id}-vm`, how: "webpack" },
    { name: "render", dep: `${id}-render`, how: "webpack" },
    {
      name: "svg",
      dep: `${id}-svg-renderer`,
      how: prebuilt.svg ? "dist" : "webpack",
    },
    {
      name: "storage",
      dep: `${id}-storage`,
      how: prebuilt.storage ? "dist" : "webpack",
    },
    { name: "audio", dep: `${id}-audio`, how: "esbuild" },
  ] satisfies WebPart[],
});

export const penguinForkStack = (id: string): WebRecipe => {
  const base = forkStack("penguinmod");
  return {
    ...base,
    id,
    parts: base.parts.map((
      p,
    ) => (p.name === "vm" ? { ...p, dep: `${id}-vm` } : p)),
  };
};
