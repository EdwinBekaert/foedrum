// Starting, checking and killing processes, which differs between operating systems
// (architecture §13). The one process runner of Foedrum and its scripts lives here.

import { execFile, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

export type Kill = (pid: number, signal: 0) => void;

export interface KillTreeOptions {
  platform?: NodeJS.Platform;
  /** Sends a signal to a process, or to a process group when `pid` is negative. */
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  /** Runs `taskkill /PID <pid> /T /F` (Windows). */
  taskkill?: (pid: number) => void;
}

/** Spawn options a process needs so that killProcessTree can end its whole tree. */
export const killableSpawnOptions = (
  platform: NodeJS.Platform = process.platform,
): { detached: boolean } => ({
  // Its own process group outside Windows; taskkill finds the tree on Windows.
  detached: platform !== 'win32',
});

/**
 * Kills a process and every process it started. On Windows through taskkill; elsewhere the
 * process must lead its own process group (spawned with `detached: true`), which is killed.
 */
export const killProcessTree = (pid: number, options: KillTreeOptions = {}): void => {
  const {
    platform = process.platform,
    signal = (target, name) => process.kill(target, name),
    taskkill = (target) => {
      execFile('taskkill', ['/PID', String(target), '/T', '/F'], { windowsHide: true }, () => {});
    },
  } = options;
  if (platform === 'win32') {
    taskkill(pid);
    return;
  }
  // The group first; a process that leads no group is killed on its own. Gone is fine.
  for (const target of [-pid, pid]) {
    try {
      signal(target, 'SIGKILL');
      return;
    } catch {
      // try the next target
    }
  }
};

// Signal 0 checks that a process exists without touching it. EPERM means it exists but
// belongs to another user, so it counts as alive.
export const isPidAlive = (pid: number, kill: Kill = process.kill): boolean => {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** How the runner ended a process it killed: its deadline passed, or its signal aborted. */
export type Killed = 'timed-out' | 'stopped';

export interface ExecOptions {
  cwd: string;
  /** The process's environment; default this process's. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Kills the process and every process it started after this long. */
  timeoutMs?: number | undefined;
  /** Kills the process and every process it started when it aborts. */
  signal?: AbortSignal | undefined;
}

export interface ExecResult {
  /** The exit code; `null` when the process could not start or was killed. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** stdout and stderr together, in the order they came. */
  output: string;
  /** Set when the runner killed the process and every process it started. */
  killed?: Killed;
}

export type ExecProcess = (
  file: string,
  args: readonly string[],
  options: ExecOptions,
) => Promise<ExecResult>;

/** The part of a started process the runner uses; a fake one in unit tests (ADR 0021). */
export interface ChildHandle {
  readonly pid?: number | undefined;
  readonly stdout: Readable;
  readonly stderr: Readable;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
}

/** The clock for deadlines; unit tests pass a fake one. */
export interface Timers {
  set: (callback: () => void, ms: number) => unknown;
  clear: (timer: unknown) => void;
}

const realTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

export interface Spawner {
  /** Starts a program without a shell; may throw when it cannot. */
  spawn: (
    file: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ) => ChildHandle;
  killTree: (pid: number) => void;
}

/**
 * A runner that starts programs through the given spawner and collects their output. At the
 * deadline, or when the signal aborts, it kills the whole tree and answers at once, without
 * waiting for output pipes that a surviving grandchild may hold open.
 */
export const execProcessWith =
  ({ spawn, killTree }: Spawner, timers: Timers = realTimers): ExecProcess =>
  (file, args, { cwd, env = process.env, timeoutMs, signal }) =>
    new Promise((done) => {
      let stdout = '';
      let stderr = '';
      let output = '';
      const ended = (exitCode: number | null, killed?: Killed): ExecResult =>
        killed === undefined
          ? { exitCode, stdout, stderr, output }
          : { exitCode, stdout, stderr, output, killed };
      const failed = (error: unknown): ExecResult => {
        const message = error instanceof Error ? error.message : String(error);
        return { exitCode: null, stdout, stderr: stderr || message, output: output || message };
      };
      if (signal?.aborted) {
        done(ended(null, 'stopped'));
        return;
      }
      let child: ChildHandle;
      try {
        child = spawn(file, [...args], { cwd, env });
      } catch (error) {
        done(failed(error));
        return;
      }
      let finished = false;
      const finish = (result: ExecResult): void => {
        if (finished) return;
        finished = true;
        if (timer !== undefined) timers.clear(timer);
        signal?.removeEventListener('abort', stop);
        done(result);
      };
      const kill = (killed: Killed): void => {
        if (finished) return;
        if (child.pid !== undefined) killTree(child.pid);
        child.stdout.destroy();
        child.stderr.destroy();
        finish(ended(null, killed));
      };
      const stop = (): void => kill('stopped');
      const timer =
        timeoutMs === undefined ? undefined : timers.set(() => kill('timed-out'), timeoutMs);
      signal?.addEventListener('abort', stop, { once: true });
      // Decode as a stream, so a multi-byte character split across chunks stays intact.
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
        output += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
        output += chunk;
      });
      child.on('error', (error) => finish(failed(error)));
      child.on('close', (code) => finish(ended(code)));
    });

/** The real runner. Unit tests use execProcessWith with a fake spawner instead (ADR 0021). */
export const execProcess: ExecProcess = execProcessWith({
  spawn: (file, args, { cwd, env }) =>
    spawn(file, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...killableSpawnOptions(),
    }),
  killTree: killProcessTree,
});

// The narrower runner the scripts' shells inject (ADR 0021): the exit code and the output
// together. Unit tests pass a fake one.
export interface ProcessOutcome {
  /** The exit code; `null` when the process could not start or was killed. */
  exitCode: number | null;
  output: string;
  killed?: Killed;
}

export type RunOptions = Pick<ExecOptions, 'timeoutMs' | 'signal'>;

export type RunProcess = (
  file: string,
  args: string[],
  cwd: string,
  options?: RunOptions,
) => Promise<ProcessOutcome>;

export const runProcessThrough =
  (exec: ExecProcess): RunProcess =>
  async (file, args, cwd, { timeoutMs, signal } = {}) => {
    const { exitCode, output, killed } = await exec(file, args, { cwd, timeoutMs, signal });
    return killed === undefined ? { exitCode, output } : { exitCode, output, killed };
  };

/** The real runner, with the output together. */
export const spawnProcess: RunProcess = runProcessThrough(execProcess);

/** Why the runner killed a process, for a message; undefined when it ended by itself. */
export const whyKilled = (killed: Killed | undefined, timeoutMs: number): string | undefined => {
  switch (killed) {
    case undefined:
      return undefined;
    case 'timed-out':
      return `timed out after ${timeoutMs / 1000} s`;
    case 'stopped':
      return 'stopped';
    default: {
      const unknown: never = killed;
      throw new Error(`unknown kill ${String(unknown)}`);
    }
  }
};

export type ListenForSignal = (name: NodeJS.Signals, handler: () => void) => void;

/**
 * A signal that aborts when this process is asked to stop: Ctrl+C, a closed terminal, a kill
 * that can be caught, Ctrl+Break on Windows. Outside Windows the runner's children lead process
 * groups of their own, which the terminal's signals do not reach, so a script that runs them
 * passes this signal on and the runner kills their trees.
 */
export const stopOnSignals = (
  listen: ListenForSignal = (name, handler) => {
    process.once(name, handler);
  },
): AbortSignal => {
  const stop = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    listen(name, () => stop.abort());
  }
  return stop.signal;
};
