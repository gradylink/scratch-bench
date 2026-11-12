import fs from "node:fs";
import path from "node:path";
import { ADAPTERS, ROOT, RUNTIME_DIR } from "../paths.ts";
import { COMPILER_VARIANTS } from "../variants.ts";
import { buildDirPart, ensureWebBundle, run } from "../webbundle.ts";
import { forkStack, replayEnv } from "./node-vm.ts";
import type { Command, Runtime } from "./types.ts";

const REPO = "https://codeberg.org/ampmod/ampmod.git";
const SRC = path.join(RUNTIME_DIR, "ampmod", "src");
const VM = path.join(SRC, "packages", "vm");
const WEB = path.join(RUNTIME_DIR, "web", "ampmod");

const git = (...args: string[]) => run(["git", ...args], SRC);
const head = async () => {
  const proc = Bun.spawn(["git", "-C", SRC, "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  return (await new Response(proc.stdout).text()).trim();
};

const command = (adapter: string) => (sb3: string): Command => ({
  cmd: ["node", path.join(ADAPTERS, adapter), "ampmod", sb3],
  cwd: ROOT,
  env: { ...(process.env as Record<string, string>), BENCH_VM_DIR: VM },
});

export const ampmod: Runtime = {
  id: "ampmod",
  name: "AmpMod",
  kind: "node",
  async setup({ offline, gui }) {
    if (!fs.existsSync(path.join(SRC, ".git"))) {
      if (offline) {
        throw new Error("no cached AmpMod clone; run without --offline once");
      }
      fs.mkdirSync(SRC, { recursive: true });
      await run([
        "git",
        "clone",
        "--quiet",
        "--depth",
        "1",
        "--no-checkout",
        REPO,
        SRC,
      ], path.dirname(SRC));
      await git("sparse-checkout", "set", "packages/vm", "packages/branding");
      await git("checkout", "--quiet");
    } else if (!offline) {
      await git("fetch", "--quiet", "--depth", "1", "origin");
      await git("reset", "--quiet", "--hard", "origin/HEAD");
      await git("sparse-checkout", "set", "packages/vm", "packages/branding");
    }
    const commit = await head();

    const stamp = path.join(VM, "node_modules", ".bench-commit");
    if (!fs.existsSync(stamp) || fs.readFileSync(stamp, "utf8") !== commit) {
      fs.rmSync(path.join(VM, "node_modules"), {
        recursive: true,
        force: true,
      });
      const root = JSON.parse(
        fs.readFileSync(path.join(SRC, "package.json"), "utf8"),
      );
      const pkgFile = path.join(VM, "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
      for (
        const name of ["webpack", "webpack-cli", "swc-loader", "@swc/core"]
      ) pkg.devDependencies[name] ??= root.devDependencies[name];
      pkg.devDependencies["@ampmod/branding"] = "file:../branding";
      fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
      await run(["bun", "install", "--ignore-scripts"], VM);
      fs.writeFileSync(stamp, commit);
    }

    const configFile = path.join(VM, "webpack.config.js");
    const text = fs.readFileSync(configFile, "utf8")
      .replaceAll("base.plugins.concat(", "(base.plugins || []).concat(")
      .replace(/loader: ('expose-loader\?\w+')/g, "use: $1")
      .replace(
        /loader: "asset\/resource",\s*options: \{[^}]*\}/g,
        'type: "asset/resource"',
      )
      .replace(
        "const CopyWebpackPlugin = require('copy-webpack-plugin');",
        "const CopyWebpackPlugin = class { apply() {} };",
      );
    fs.writeFileSync(configFile, text);

    const manifestFile = path.join(WEB, "manifest.json");
    const built = fs.existsSync(manifestFile) &&
      JSON.parse(fs.readFileSync(manifestFile, "utf8")).recipe === commit;
    if (gui && !built) {
      const turbowarp = await ensureWebBundle(forkStack("turbowarp"));
      fs.rmSync(WEB, { recursive: true, force: true });
      fs.cpSync(turbowarp, WEB, { recursive: true });
      fs.rmSync(path.join(WEB, "vm"), { recursive: true, force: true });
      await buildDirPart("vm", VM, path.join(WEB, "vm"), "webpack", {
        installed: true,
      });
      const manifest = JSON.parse(
        fs.readFileSync(path.join(turbowarp, "manifest.json"), "utf8"),
      );
      fs.writeFileSync(
        manifestFile,
        JSON.stringify(
          { ...manifest, recipe: commit, deps: { ampmod: commit } },
          null,
          2,
        ),
      );
    }
    return {
      version: commit.slice(0, 7),
      detail: { commit, repo: REPO },
      variants: COMPILER_VARIANTS,
    };
  },
  headless: { command: command("node-vm.mjs") },
  gui: {
    command: command("chromium-vm.mjs"),
    replay: (sb3, r) => {
      const c = command("chromium-vm.mjs")(sb3);
      return { ...c, env: { ...c.env, ...replayEnv(r) } };
    },
  },
};
