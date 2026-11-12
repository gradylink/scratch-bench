// usage: bun run fetch-projects
// Downloads the projects in projects/manifest.json into .cache/projects. The files are the ones the
// recordings were made with, as TurboWarp's pianola benchmark keeps them (github.com/TurboWarp/pianola):
// each is named by its SHA-256, which the download is checked against.
import fs from "node:fs";
import { manifest, PROJECT_FILES, projectFile, type ProjectEntry } from "./projects.ts";

const UA = { "User-Agent": "scratch-bench (github.com/gradylink/scratch-bench)" };
const BLOBS = "https://blobs.turbowarp.xyz/benchmarks/v1";

const get = async (url: string): Promise<Uint8Array> => {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(120_000) });
    } catch (e) {
      if (attempt === 3) throw e;
      await Bun.sleep(1000 * attempt);
      continue;
    }
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
    if (attempt === 3 || res.status === 404) throw new Error(`${res.status} ${url}`);
    await Bun.sleep(1000 * attempt);
  }
};

const sha256 = (data: Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex");

const fetchProject = async (p: ProjectEntry) => {
  const data = await get(`${BLOBS}/${p.sha256}.sb3`);
  if (sha256(data) !== p.sha256) throw new Error("the download doesn't match its SHA-256");
  // Written whole or not at all, so an interrupted fetch never leaves a broken sb3 behind.
  fs.writeFileSync(`${projectFile(p)}.part`, data);
  fs.renameSync(`${projectFile(p)}.part`, projectFile(p));
};

/** Fetches the projects not downloaded yet. */
export const fetchProjects = async (
  wanted: ProjectEntry[],
  log: (line: string) => void,
): Promise<void> => {
  fs.mkdirSync(PROJECT_FILES, { recursive: true });
  const missing = wanted.filter((p) => !fs.existsSync(projectFile(p)));
  let next = 0;
  const worker = async () => {
    while (next < missing.length) {
      const p = missing[next++];
      try {
        await fetchProject(p);
        log(`${p.id} ${p.title}: fetched`);
      } catch (e) {
        log(`${p.id} ${p.title}: ${(e as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
};

if (import.meta.main) {
  const wanted = manifest();
  await fetchProjects(wanted, console.log);
  const have = wanted.filter((p) => fs.existsSync(projectFile(p))).length;
  console.log(`${have} of ${wanted.length} projects in ${PROJECT_FILES}`);
  process.exit(have ? 0 : 1);
}
