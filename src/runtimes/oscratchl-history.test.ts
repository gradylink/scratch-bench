import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runOnce } from "../measure.ts";
import { oscratchlHistory } from "./oscratchl-history.ts";
import type { Suite } from "../suites.ts";
import type { Variant } from "./types.ts";

let tmp: string;
let project: string;
const shas: Record<string, string> = {};
const suite = {
  id: "parity",
  isDone: (l: string) => /Tests Were/.test(l),
} as unknown as Suite;

const git = (cwd: string, date: string | undefined, ...args: string[]) => {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
    ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
  };
  const r = Bun.spawnSync(["git", ...args], { cwd, env });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oscratchl-"));
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "fonts"));
  fs.writeFileSync(path.join(repo, "fonts", "f.txt"), "font");
  git(repo, undefined, "init", "-q", "-b", "main");
  for (
    const [date, passed] of [["2026-10-01T12:00:00Z", 8], [
      "2026-10-10T12:00:00Z",
      10,
    ]] as const
  ) {
    fs.writeFileSync(path.join(repo, "src", "main.osl"), String(passed));
    git(repo, date, "add", "-A");
    git(repo, date, "commit", "-q", "-m", `v${passed}`);
    shas[date.slice(0, 10)] = git(repo, undefined, "rev-parse", "HEAD");
  }
  const fake = path.join(tmp, "fake-osl");
  // The built "oscratchl" handles `<sb3> --compile -o OUT` by copying itself, so the compiled program prints the same.
  fs.writeFileSync(
    fake,
    `#!/bin/sh
# usage: fake-osl compile src/main.osl -o OUT
n=$(cat "$2")
printf '#!/bin/sh\\nif [ "$2" = --compile ]; then cp "$0" "$4"; exit 0; fi\\necho "status line"\\necho "Sprite1: [PASSED] All Tests Were Successful: %s/10"\\n' "$n" > "$4"
chmod +x "$4"
`,
  );
  project = path.join(tmp, "x.sb3");
  fs.writeFileSync(project, "project");
  fs.chmodSync(fake, 0o755);
  process.env.OSL_BIN = fake;
  process.env.OSCRATCHL_REPO = repo;
  process.env.BENCH_BACKFILL_DIR = path.join(tmp, "state");
});
afterAll(() => {
  delete process.env.OSL_BIN;
  delete process.env.OSCRATCHL_REPO;
  delete process.env.BENCH_BACKFILL_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("oscratchl history", () => {
  const resolve = oscratchlHistory.custom!.resolve;

  test("picks the newest commit on or before the end of each date", async () => {
    expect((await resolve("2026-10-05", "parity"))?.custom?.sha).toBe(
      shas["2026-10-01"],
    );
    expect((await resolve("2026-10-10", "parity"))?.custom?.sha).toBe(
      shas["2026-10-10"],
    );
    expect((await resolve("2026-10-20", "parity"))?.custom?.sha).toBe(
      shas["2026-10-10"],
    );
  });

  test("has no pin before the first commit", async () => {
    expect(await resolve("2026-09-01", "parity")).toBeNull();
  });

  test("builds a commit and runs it, reading the project's output without a marker", async () => {
    const pin = (await resolve("2026-10-05", "parity"))!;
    const launch = await oscratchlHistory.custom!.build(pin, "parity");
    expect(launch.display).toBe(true);
    const r = await runOnce(launch.command(project), suite, 20_000);
    expect(r.ok).toBe(true);
    expect(r.lines).toEqual(["[PASSED] All Tests Were Successful: 8/10"]);
    const newer = await oscratchlHistory.custom!.build(
      (await resolve("2026-10-20", "parity"))!,
      "parity",
    );
    expect((await runOnce(newer.command(project), suite, 20_000)).lines[0])
      .toContain("10/10");
  });

  test("fonts are placed beside the binary, and the performance run is windowless", async () => {
    const pin = (await resolve("2026-10-20", "performance"))!;
    const launch = await oscratchlHistory.custom!.build(pin, "performance");
    expect(launch.display).toBe(false);
    const cmd = launch.command(project);
    expect(cmd.cmd).toContain("--headless");
    expect(path.basename(cmd.cmd[0]!)).toStartWith("compiled-");
    expect(
      fs.readFileSync(
        path.join(path.dirname(cmd.cmd[0]!), "fonts", "f.txt"),
        "utf8",
      ),
    ).toBe("font");
  });

  test("the compiler mode runs the --compile executable and the interpreter mode runs the project directly", async () => {
    const [compilerMode, interpreterMode] = oscratchlHistory.variants as Variant[];
    const pin = (await resolve("2026-10-20", "performance"))!;
    const launch = await oscratchlHistory.custom!.build(pin, "performance");
    const compiledCmd = launch.command(project, compilerMode).cmd;
    const interpretedCmd = launch.command(project, interpreterMode).cmd;
    expect(path.basename(compiledCmd[0]!)).toStartWith("compiled-");
    expect(compiledCmd).not.toContain(project);
    expect(path.basename(interpretedCmd[0]!)).toBe("oscratchl");
    expect(interpretedCmd[1]).toBe(project);
    for (const cmd of [compiledCmd, interpretedCmd]) {
      const r = await runOnce({ ...launch.command(project), cmd }, suite, 20_000);
      expect(r.lines[0]).toContain("10/10");
    }
  });

  test("a compiler that fails gives an error that says what to set", async () => {
    const bad = path.join(tmp, "bad-osl");
    fs.writeFileSync(bad, "#!/bin/sh\necho nope >&2\nexit 1\n");
    fs.chmodSync(bad, 0o755);
    const keep = process.env.OSL_BIN;
    process.env.OSL_BIN = bad;
    fs.rmSync(path.join(tmp, "state", "oscratchl", shas["2026-10-01"]!), {
      recursive: true,
      force: true,
    });
    await expect(
      oscratchlHistory.custom!.build(
        (await resolve("2026-10-05", "parity"))!,
        "parity",
      ),
    ).rejects.toThrow(/OSL_BIN/);
    process.env.OSL_BIN = keep;
  });
});
