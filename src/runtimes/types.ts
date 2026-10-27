export interface Command {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
  projectLine?: RegExp;
}

export interface Launcher {
  /** `variant` is the VM mode being run, for runtimes whose modes are different programs rather than an env var. */
  command(sb3: string, variant?: Variant | null): Command;
  display?: boolean;
}

export interface Variant {
  id: string;
  name: string;
  default: boolean;
  env?: Record<string, string>;
  prepare?(sb3: string): void;
}

export type VariantInfo = Pick<Variant, "id" | "name" | "default">;

export interface SetupInfo {
  version: string;
  detail?: Record<string, string>;
  variants?: Variant[];
}

export interface SetupOptions {
  offline: boolean;
  gui: boolean;
}

export type SuiteId = "performance" | "parity";

export interface GitPart {
  git: string;
  branch?: string;
  provides: Record<string, string>;
  shared?: string[];
  fallback?: Record<string, string | { git: string; branch?: string }>;
}

export interface NpmPart {
  npm: string;
  provides: string;
}

export type HistoryPart = GitPart | NpmPart;

export type PinPart =
  | {
    git: string;
    commit: string;
    provides: Record<string, string>;
    shared?: string[];
  }
  | { npm: string; version: string; provides: string };

export interface Pin {
  parts: PinPart[];
  custom?: Record<string, string>;
}

export interface HistoricLaunch {
  /** `variant` is the VM mode being run, for runtimes whose modes are different programs rather than an env var. */
  command(sb3: string, variant?: Variant | null): Command;
  display?: boolean;
  note?: string;
}

export interface HistorySpec {
  since: Partial<Record<SuiteId, string>>;
  latestOnly?: SuiteId[];
  variants?: Variant[] | ((pin: Pin) => Promise<Variant[]>);
  parts?: HistoryPart[];
  custom?: {
    resolve(date: string, suite: SuiteId): Promise<Pin | null>;
    build(pin: Pin, suite: SuiteId): Promise<HistoricLaunch>;
  };
}

export interface Runtime {
  id: string;
  name: string;
  kind: "node" | "native";
  setup(opts: SetupOptions): Promise<SetupInfo>;
  headless?: Launcher;
  gui?: Launcher;
  history?: HistorySpec;
}
