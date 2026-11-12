import fs from "fs";
import http from "http";
import path from "path";
import { createRequire } from "module";
import { chromium } from "playwright-core";
import { replayInPage, separateIds } from "./replay-runner.mjs";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
process.stdout.on("error", () => process.exit(0));

const [kind, file] = process.argv.slice(2);
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

// With a recording, the project is replayed against it (index.html `replay`) instead of run.
const recording = process.env.BENCH_RECORDING;
const replayId = process.env.BENCH_REPLAY_ID ?? "project";
const budgetMs = Number(process.env.BENCH_REPLAY_BUDGET_MS ?? 60_000);

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
  else if (url === "/replay.js") p = path.join(root, "runtimes/replay.js");
  else if (url === "/project.sb3") p = path.resolve(file);
  else if (url === "/recording.json" && recording) p = path.resolve(recording);
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
      const script = recording && p.endsWith(".js") && /^\/(web|node_modules|chunks|assets)\//.test(url);
      res.end(script ? separateIds(d.toString("utf8")) : d);
    }
  });
}).listen(0, "127.0.0.1", async () => {
  const exe = process.env.CHROME ||
    (fs.existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
  const browser = await chromium.launch({
    executablePath: exe,
    args: [
      ...(process.env.CHROME_NO_SANDBOX ? ["--no-sandbox"] : []),
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, async () => {
      await browser.close().catch(() => {});
      process.exit(143);
    });
  }
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("pageerror", e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  const finished = new Promise((resolve) => {
    page.on("console", (m) => {
      const text = m.text();
      if (process.env.BENCH_DEBUG) process.stderr.write(`console: ${text}\n`);
      if (text.startsWith("[PROJECT] ")) process.stdout.write(`${text}\n`);
      else if (text === "[BENCH-IDLE]") resolve();
    });
  });
  const compiler = process.env.BENCH_COMPILER !== "0";
  if (recording) {
    await replayInPage(page, { recording, replayId, budgetMs }, () =>
      page.evaluate(
        ([k, s, c, id, b, d]) => window.replay(k, s, c, id, b, d),
        [kind, scripts, compiler, replayId, budgetMs, process.env.BENCH_REPLAY_DRAW === "1"],
      ));
    await browser.close();
    server.close();
    process.exit(0);
  }
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
