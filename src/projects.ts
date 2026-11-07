import fs from "node:fs";
import path from "node:path";
import { CACHE, ROOT } from "./paths.ts";

/** Real Scratch projects, each with a recording of someone using it (`projects/recordings`). */
export const PROJECTS_DIR = path.join(ROOT, "projects");
/** Where `bun run fetch-projects` puts the sb3s. They are not committed. */
export const PROJECT_FILES = path.join(CACHE, "projects");
/** Real time each project may replay for before it's cut short; the runner reads the same variable. */
export const PROJECT_BUDGET_MS = Number(process.env.BENCH_PROJECT_BUDGET_MS ?? 300_000);

export interface ProjectEntry {
  id: string;
  title: string;
  author: string;
  /** sha256 of the project.json the recording was replayed against. */
  sha256: string;
}

export const manifest = (): ProjectEntry[] =>
  JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, "manifest.json"), "utf8"));

export const projectFile = (id: string) => path.join(PROJECT_FILES, `${id}.sb3`);
export const recordingFile = (id: string) =>
  path.join(PROJECTS_DIR, "recordings", `${id}.json`);

/**
 * The fetched projects, as the playlist the browser runner replays. Throws when none are fetched.
 */
export const playlist = (): { id: string; sb3: string; recording: string }[] => {
  const list = manifest()
    .filter((p) => fs.existsSync(projectFile(p.id)))
    .map((p) => ({ id: p.id, sb3: projectFile(p.id), recording: recordingFile(p.id) }));
  if (!list.length) {
    throw new Error("no projects fetched: run `bun run fetch-projects` first");
  }
  return list;
};
