import { clipcc } from "./clipcc.ts";
import { forkphorus } from "./forkphorus.ts";
import { gandi } from "./gandi.ts";
import { mistwarp } from "./mistwarp.ts";
import { nitrobolt } from "./nitrobolt.ts";
import { oscratchl } from "./oscratchl.ts";
import { penguinmod } from "./penguinmod.ts";
import { penguinmodPort } from "./penguinmod-port.ts";
import { scratch } from "./scratch.ts";
import { scratchEverywhere } from "./scratch-everywhere.ts";
import { turbowarp } from "./turbowarp.ts";
import { xyoCpp } from "./xyo.ts";
import type { Runtime } from "./types.ts";

export const RUNTIMES: Runtime[] = [
  scratch,
  turbowarp,
  mistwarp,
  nitrobolt,
  penguinmod,
  scratchEverywhere,
  oscratchl,
  xyoCpp,
  gandi,
  penguinmodPort,
  clipcc,
  forkphorus,
];

export const selectRuntimes = (ids: string[] | undefined): Runtime[] => {
  if (!ids) return RUNTIMES;
  return ids.map((id) => {
    const r = RUNTIMES.find((x) => x.id === id);
    if (!r) {
      throw new Error(
        `unknown runtime "${id}" (known: ${
          RUNTIMES.map((x) => x.id).join(", ")
        })`,
      );
    }
    return r;
  });
};
