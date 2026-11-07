import fs from "fs";
import http from "http";
import path from "path";
import { createRequire } from "module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
process.stdout.on("error", () => process.exit(0));

const [kind, file] = process.argv.slice(2);
// A .json file is a playlist of recorded projects to replay (the projects suite); otherwise it's
// one sb3 to run from the green flag.
const playlist = file?.endsWith(".json")
  ? JSON.parse(fs.readFileSync(file, "utf8"))
  : null;
const PROJECT_BUDGET_MS = Number(process.env.BENCH_PROJECT_BUDGET_MS ?? 300000);
const KINDS = [
  "scratch",
  "turbowarp",
  "mistwarp",
  "nitrobolt",
  "penguinmod",
  "gandi",
  "penguinmod-port",
  "clipcc",
  "snailide",
  "electramod",
  "02engine",
  "codetorch",
  "ampmod",
];
if (!KINDS.includes(kind) || !file) {
  console.error(
    `usage: node chromium-vm.mjs <${KINDS.join("|")}> <project.sb3>`,
  );
  process.exit(2);
}

const bundleDir = process.env.BENCH_BUNDLE_DIR ??
  path.join(root, ".cache/runtimes/web", kind);
let scripts;
if (kind !== "scratch" || process.env.BENCH_BUNDLE_DIR) {
  const manifest = path.join(bundleDir, "manifest.json");
  if (!fs.existsSync(manifest)) {
    console.error(`no browser bundle for ${kind}; run \`bun run setup\` first`);
    process.exit(2);
  }
  scripts = JSON.parse(fs.readFileSync(manifest, "utf8")).scripts.map((s) =>
    `/web/${s}`
  );
}

const audioPath = path.join(root, ".cache", "runtimes", "web", "audio.js");
if (!fs.existsSync(audioPath)) {
  const { buildSync } = require("esbuild");
  const out = buildSync({
    entryPoints: [require.resolve("scratch-audio")],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "ScratchAudio",
    write: false,
  }).outputFiles[0].text;
  fs.mkdirSync(path.dirname(audioPath), { recursive: true });
  fs.writeFileSync(audioPath, out);
}

const types = {
  ".js": "application/javascript",
  ".html": "text/html",
  ".json": "application/json",
};
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  let p;
  if (url === "/" || url === "/index.html") {
    p = path.join(root, "runtimes/chromium/index.html");
  } else if (url === "/audio.js") p = audioPath;
  else if (url === "/project.sb3") p = path.resolve(file);
  else if (playlist && /^\/(projects\/\d+\.sb3|recordings\/\d+\.json)$/.test(url)) {
    const id = url.match(/\d+/)[0];
    const item = playlist.find((x) => x.id === id);
    p = item && (url.startsWith("/projects/") ? item.sb3 : item.recording);
  }
  else if (url.startsWith("/node_modules/")) p = path.join(root, url);
  else if (url.startsWith("/web/")) p = path.join(bundleDir, url.slice(5));
  else if (/^\/(chunks|assets)\//.test(url)) {
    p = [
      ...["vm", "render", "svg", "storage"].map((part) =>
        path.join(bundleDir, part, url)
      ),
      ...[
        "@scratch/scratch-vm",
        "@scratch/scratch-svg-renderer",
        "@scratch/scratch-render",
        "@scratch/scratch-storage",
      ].map((m) => path.join(root, "node_modules", m, "dist/web", url)),
    ].find((c) => fs.existsSync(c));
  }
  if (!p) {
    res.writeHead(404).end();
    return;
  }
  fs.readFile(p, (e, d) => {
    if (e) res.writeHead(404).end();
    else {
      res.writeHead(200, {
        "Content-Type": types[path.extname(p)] || "application/octet-stream",
      });
      res.end(d);
    }
  });
}).listen(0, "127.0.0.1", async () => {
  const exe = process.env.CHROME ||
    (fs.existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
  const launch = () =>
    chromium.launch({
      executablePath: exe,
      args: [
        ...(process.env.CHROME_NO_SANDBOX ? ["--no-sandbox"] : []),
        // Software WebGL by default, so every host renders the same way; BENCH_GPU=1 uses the
        // GPU through Vulkan instead, which is far faster for render-heavy projects.
        ...(process.env.BENCH_GPU === "1"
          ? ["--use-angle=vulkan", "--enable-features=Vulkan", "--ignore-gpu-blocklist"]
          : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]),
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
  let browser = await launch();
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, async () => {
      await browser.close().catch(() => {});
      process.exit(143);
    });
  }
  const open = async () => {
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.error("pageerror", e.message));
    page.on("console", (m) => {
      if (process.env.BENCH_DEBUG) process.stderr.write(`console: ${m.text()}\n`);
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    return page;
  };
  const compiler = process.env.BENCH_COMPILER !== "0";

  if (playlist) {
    // One project at a time, each in a fresh page so nothing one project leaves behind (VM state,
    // compiled code, garbage) slows the next. A project still stuck in a frame a minute past its
    // budget can't be interrupted from outside, so the browser is restarted for the rest.
    for (const { id } of playlist) {
      const page = await open();
      let timer;
      const line = await Promise.race([
        page.evaluate(
          ([k, s, c, i, b]) => window.replay(k, s, c, i, b),
          [kind, scripts, compiler, id, PROJECT_BUDGET_MS],
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), PROJECT_BUDGET_MS + 60000);
        }),
      ]).catch((e) => `${id} | error | ${String(e.message).split("\n")[0]}`);
      clearTimeout(timer);
      if (line === null) {
        process.stdout.write(`[PROJECT] ${id} | error | stopped responding\n`);
        await browser.close().catch(() => {});
        browser = await launch();
      } else {
        process.stdout.write(`[PROJECT] ${line}\n`);
        await page.close();
      }
    }
    process.stdout.write("[PROJECT] DONE\n");
    await browser.close();
    server.close();
    process.exit(0);
  }

  const page = await open();
  const finished = new Promise((resolve) => {
    page.on("console", (m) => {
      const text = m.text();
      if (text.startsWith("[PROJECT] ")) process.stdout.write(`${text}\n`);
      else if (text === "[BENCH-IDLE]") resolve();
    });
  });
  await page.evaluate(([k, s, c]) => window.start(k, s, c), [
    kind,
    scripts,
    compiler,
  ]);
  await finished;
  await browser.close();
  server.close();
  process.exit(0);
});
