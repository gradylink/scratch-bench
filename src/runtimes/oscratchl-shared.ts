import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { run } from "../webbundle.ts";
import type { Command, Replay, Variant } from "./types.ts";

export const REPO = "https://git.rotur.dev/Mist/oscratchl.git";

export const PROJECT_LINE = /^[^:|\[\]]+: (.*)$/;

const HEADLESS_FRAMES = "100000000";

export const compile = async (cwd: string, out: string): Promise<void> => {
  const osl = process.env.OSL_BIN ?? "osl";
  try {
    await run([osl, "compile", "src/main.osl", "-o", out], cwd);
  } catch (e) {
    throw new Error(
      `could not build oscratchl with ${osl} (the compiler has to match the source): ${
        (e as Error).message
      }\n` +
        "Set OSL_BIN to the compiler to use, or OSCRATCHL_BINARY to a binary you built yourself.",
    );
  }
};

/**
 * Compiles the project to a native executable with `oscratchl --compile`, once per project and binary, and returns it.
 * This runs before the measured process starts, so compile time is not counted. The executable sits beside the
 * interpreter so it finds fonts/. `runtimeSource` is oscratchl's src/ tree, which the compiler needs.
 */
const compiled = (bin: string, sb3: string, runtimeSource?: string): string => {
  const st = fs.statSync(bin);
  const key = createHash("sha1").update(fs.readFileSync(sb3))
    .update(`${st.size}:${st.mtimeMs}`).digest("hex").slice(0, 12);
  const out = path.join(path.dirname(bin), `compiled-${key}`);
  if (fs.existsSync(out)) return out;
  // Parallel parity runs may compile the same project; each writes its own file and the rename settles it.
  const tmp = `${out}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  const r = Bun.spawnSync([
    bin,
    sb3,
    "--compile",
    "-o",
    tmp,
    ...(runtimeSource ? ["--runtime-source", runtimeSource] : []),
  ], { cwd: path.dirname(bin), stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0 || !fs.existsSync(tmp)) {
    fs.rmSync(tmp, { force: true });
    const why = `${r.stderr}\n${r.stdout}`.trim().split("\n").slice(-6).join(
      " | ",
    );
    throw new Error(`oscratchl --compile failed: ${why}`);
  }
  fs.renameSync(tmp, out);
  return out;
};

/** The compiler mode runs the `--compile` executable; the interpreter mode runs the project with oscratchl itself. */
const program = (
  bin: string,
  sb3: string,
  runtimeSource: string | undefined,
  variant: Variant | null | undefined,
): string[] =>
  variant?.id === "interpreter"
    ? [bin, sb3]
    : [compiled(bin, sb3, runtimeSource)];

export const headlessCommand = (
  bin: string,
  sb3: string,
  runtimeSource?: string,
  variant?: Variant | null,
): Command => ({
  cmd: [
    ...program(bin, sb3, runtimeSource, variant),
    "--headless",
    HEADLESS_FRAMES,
  ],
  cwd: path.dirname(bin),
  projectLine: PROJECT_LINE,
});

/** A replay of a recording (projects/REPLAY.md), headless, in the same program as a normal run. */
export const replayCommand = (
  bin: string,
  sb3: string,
  r: Replay,
  runtimeSource?: string,
  variant?: Variant | null,
): Command => ({
  cmd: [
    ...program(bin, sb3, runtimeSource, variant),
    "--replay",
    r.recording,
    "--replay-id",
    r.id,
    "--replay-budget",
    String(r.budgetMs),
  ],
  cwd: path.dirname(bin),
  projectLine: /^\[PROJECT\] (.*)$/,
});

/**
 * Whether a build of oscratchl has replay mode as projects/REPLAY.md now describes it (older ones
 * would take the flags for the project; the first builds with it kept time in seconds and failed a
 * cut replay rather than bounding it). The bound's template is only in builds since.
 */
export const canReplay = (bin: string): boolean => {
  try {
    const built = fs.readFileSync(bin);
    // A cut replay's bound ({next}:{script}) and the state at each checkpoint (BENCH_STATE_DUMP)
    // came in that order; a build with neither or only the first can't be compared.
    return built.includes("--replay-budget") && built.includes("{next}:{script}") && built.includes("BENCH_STATE_DUMP");
  } catch {
    return false;
  }
};

export const windowCommand = (
  bin: string,
  sb3: string,
  runtimeSource?: string,
  variant?: Variant | null,
): Command => ({
  cmd: [...program(bin, sb3, runtimeSource, variant), "--mute"],
  cwd: path.dirname(bin),
  projectLine: PROJECT_LINE,
});
