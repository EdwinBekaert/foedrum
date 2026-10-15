// `foedrum doctor`, the core (ADR 0021): turns facts gathered from the machine into a report of
// the tools Foedrum needs, the effective isolation level (ADR 0010, architecture §13) and what
// is missing. doctor-facts.ts gathers the facts.

/** The tools doctor looks for on PATH. */
export type ToolName = 'npm' | 'git' | 'claude' | 'bwrap' | 'socat' | 'podman' | 'docker';

/** A tool found on PATH, and what its version command answered. */
export interface ToolRun {
  path: string;
  /** The exit code of the version command; `null` when it could not start or was killed. */
  exitCode: number | null;
  output: string;
}

export interface DoctorFacts {
  platform: NodeJS.Platform;
  /** `os.release()`; on Linux it tells WSL 1 and WSL 2 apart. */
  kernelRelease: string;
  /** `process.versions.node` */
  node: string;
  /** Each tool, or `undefined` when it is not on PATH. */
  tools: Readonly<Record<ToolName, ToolRun | undefined>>;
}

/** The isolation levels Foedrum can reach without configuration (ADR 0010). */
export type IsolationLevel = 'sandboxed' | 'permissions only';

/** One row of the report: a tool, its version and where it is; no path when it was not found. */
export interface ToolLine {
  name: string;
  /** `undefined` when the tool did not report one. */
  version: string | undefined;
  path: string | undefined;
}

export interface Problem {
  /** A required problem stops Foedrum from running brewers; doctor then exits 1. */
  required: boolean;
  what: string;
  fix: string;
}

export interface Diagnosis {
  tools: readonly ToolLine[];
  isolation: { level: IsolationLevel; why: string };
  /** A container runtime, which makes the optional container level possible. */
  container: { name: 'podman' | 'docker'; version: string | undefined; path: string } | undefined;
  advice: readonly string[];
  problems: readonly Problem[];
  /** No required problem. */
  ok: boolean;
}

export const diagnose = (_facts: DoctorFacts): Diagnosis => {
  throw new Error('not implemented');
};

export const formatDiagnosis = (_diagnosis: Diagnosis): string => {
  throw new Error('not implemented');
};
