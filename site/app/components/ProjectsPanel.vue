<script setup lang="ts">
import type { ProjectResult } from "#shared/types";
import { projectTitle } from "#shared/projects";
import { agreement, PROJECT_REFERENCE, referenceFor, relativeSpeed } from "#shared/scoring";

const titleOf = (id: string) =>
  runtimes.value.map((r) => r.projects[id]?.title).find(Boolean) ?? projectTitle(id);

const { host } = useBenchState();
const { data: latest } = await useLatestData(host);
const shown = useShown();

const runtimes = computed(() =>
  (latest.value?.projects ?? []).filter((r) => shown(r.id))
);
const ids = computed(() => [
  ...new Set(runtimes.value.flatMap((r) => Object.keys(r.projects))),
]);
const recordedFrames = (id: string) =>
  runtimes.value.map((r) => r.projects[id]?.recorded_frames).find((x) => typeof x === "number") ?? null;

const cut = (p: ProjectResult) =>
  p.frames != null && p.recorded_frames != null && p.frames < p.recorded_frames;

// Every runtime's replays from the reference's run (each runtime's latest may be from another
// night), including hidden runtimes, to find each project's reference.
const referenceRun = computed(() =>
  (latest.value?.projects ?? []).find((r) => r.id === PROJECT_REFERENCE)?.timestamp ?? null
);
const all = computed(() =>
  Object.fromEntries(
    (latest.value?.projects ?? [])
      .filter((r) => r.timestamp === referenceRun.value)
      .map((r) => [r.id, r.projects]),
  )
);
const referenceName = computed(() =>
  (latest.value?.projects ?? []).find((r) => r.id === PROJECT_REFERENCE)?.name ?? PROJECT_REFERENCE
);
type Row = { timestamp: string; projects: Record<string, ProjectResult> };
// Only replays from the same run as the reference's are compared with it: another night's ran on
// another machine state, and maybe another version of the replay.
const speedOf = (id: string, r: Row) =>
  r.timestamp === referenceRun.value ? relativeSpeed(r.projects[id], referenceFor(id, all.value)) : null;

const cell = (id: string, r: Row) => {
  const p = r.projects[id];
  if (!p) return { text: "-", state: "missing" };
  if (p.error) return { text: "error", state: "error", title: p.error };
  if (!p.checkpoints) {
    // Older results, from replays in real time.
    return p.ms ? { text: fmtMs(p.ms.median), state: "ok", title: "real time (an older run)" } : { text: "-", state: "missing" };
  }
  const speed = speedOf(id, r);
  // Where its state stopped agreeing with the reference's: it was computing something else.
  const agreed = r.timestamp === referenceRun.value ? agreement(p, referenceFor(id, all.value)) : null;
  const differs = agreed?.differs ?? null;
  const notes = [
    `${fmtMs(p.script_ms?.median)} of scripts for ${p.frames} of ${p.recorded_frames} frames`,
    `${fmtMs(p.frame_ms?.median)} in all, ${fmtMs(p.draw_ms?.median)} of it drawing`,
    speed !== null && differs !== null
      ? `compared with ${referenceName.value} on frames 1-${agreed!.through}, the last before its state stopped agreeing (at frame ${differs})`
      : differs !== null
      ? `its state stopped agreeing with ${referenceName.value}'s at frame ${differs}, too soon to compare it`
      : speed !== null
      ? Object.keys(p.checkpoints ?? {}).some((f) => Number(f) > (p.frames ?? 0))
        ? `cut in frame ${(p.frames ?? 0) + 1}, which didn't end: compared with ${referenceName.value} as if it had finished it then, which it would only have done later`
        : `compared with ${referenceName.value} on the same frames` : "not comparable",
    p.drifted ? `${p.drifted} frames made a different number of passes than recorded` : "",
  ].filter(Boolean);
  return {
    text: `${differs !== null ? "≠" : ""}${p.drifted ? "*" : ""}${speed !== null ? `${speed.toFixed(2)}×` : "-"}`,
    state: cut(p) ? "cut" : "ok",
    title: notes.join("; "),
  };
};

// Each runtime's projects score: the geometric mean of its speeds, as the overall score counts it.
const totals = computed(() =>
  runtimes.value.map((r) => {
    const speeds = Object.keys(r.projects)
      .map((id) => speedOf(id, r))
      .filter((x): x is number => x !== null);
    return {
      id: r.id,
      counted: speeds.length,
      total: Object.keys(r.projects).length,
      score: speeds.length ? Math.exp(speeds.reduce((n, x) => n + Math.log(x), 0) / speeds.length) : null,
    };
  })
);
</script>

<template>
  <section v-if="runtimes.length" class="panel projects"
    aria-labelledby="projects-title">
    <header class="panel__header">
      <h2 id="projects-title" class="panel__title">Real projects</h2>
      <p class="panel__subtitle">
        How fast each runtime runs the first 10 seconds of a recording of someone using each project, replayed frame by frame
        and the same in every runtime (like TurboWarp's pianola): its script time against TurboWarp's on exactly the same
        frames, in the same run, so 0.5× is half as fast. A runtime that can't get through the recording in its 10 seconds is compared on
        the frames it did. ≠ its state stopped agreeing with TurboWarp's, so it is only compared on the frames before;
        * made a different number of passes than the recording.
      </p>
    </header>

    <div class="projects__scroll">
      <table class="projects__table">
        <thead>
          <tr>
            <th scope="col">Project</th>
            <th scope="col" class="projects__num">Frames</th>
            <th v-for="r in runtimes" :key="r.id" scope="col"
              class="projects__num">
              <span class="runtime-dot" :data-runtime="r.id" /> {{ r.name }}<template
                v-if="r.launcher === 'headless'"> (headless)</template>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="id in ids" :key="id">
            <th scope="row">{{ titleOf(id) }}</th>
            <td class="projects__num">{{ recordedFrames(id) ?? "-" }}</td>
            <td v-for="r in runtimes" :key="r.id" class="projects__num"
              :data-state="cell(id, r).state"
              :title="cell(id, r).title ?? undefined">
              {{ cell(id, r).text }}
            </td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Projects score</th>
            <td />
            <td v-for="t in totals" :key="t.id" class="projects__num">
              <template v-if="t.score !== null">{{ t.score.toFixed(2) }}×<template v-if="t.counted < t.total"> ({{ t.counted }}/{{ t.total }})</template></template>
              <template v-else>-</template>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
    <p class="parity__note">
      Only runtimes that can replay a recording frame by frame (projects/REPLAY.md in the repository) take part.
    </p>
  </section>
</template>
