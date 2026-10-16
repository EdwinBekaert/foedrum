// Starting, checking and killing processes, which differs between operating systems
// (architecture §13). The one process runner of Foedrum and its scripts lives here.

import { execFile, spawn } from 'node:child_process';
import { join, win32 } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { environmentVariable, resolveExecutable } from './executables.ts';
import { JOB_OBJECT_FAILED, jobObjectCommand, jobObjectRefusal } from './job-object.ts';
import { windowsCommandLine } from './shell.ts';

export type Kill = (pid: number, signal: 0) => void;

export interface KillTreeOptions {
  platform?: NodeJS.Platform;
  /** Sends a signal to a process, or to a process group when `pid` is negative. */
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  /** Runs `taskkill /PID <pid> /T /F` (Windows). */
  taskkill?: (pid: number) => void;
  /** The clock for the grace period between SIGTERM and SIGKILL (POSIX). */
  timers?: Timers;
}

/** Spawn options a process needs so that killProcessTree can end its whole tree. */
export const killableSpawnOptions = (
  platform: NodeJS.Platform = process.platform,
): { detached: boolean } => ({
  // Its own process group outside Windows; taskkill finds the tree on Windows.
  detached: platform !== 'win32',
});

/**
 * What the runner passes to `spawn`: a program and its arguments, or a command line for the shell
 * at the path `shell` names; and the environment to start it in.
 */
export interface SpawnCommand {
  file: string;
  args: string[];
  shell: string | false;
  env: NodeJS.ProcessEnv;
}

/**
 * How to start a file. On Windows a `.cmd` or `.bat` file (npm.cmd, npm's claude.cmd) cannot
 * start without cmd.exe, so it becomes a command line for the shell, every part checked and quoted
 * (windowsCommandLine; throws on a part cmd.exe could read as syntax). cmd.exe is named by its full
 * path, never through ComSpec or a lookup, and runs with NoDefaultCurrentDirectoryInExePath set,
 * so the bare `node` in npm's shims is never one planted in the working directory (#12). Anything
 * else starts directly, without a shell.
 */
export const spawnCommand = (
  file: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): SpawnCommand =>
  platform === 'win32' && /\.(?:cmd|bat)$/i.test(file)
    ? {
        file: windowsCommandLine(file, args),
        args: [],
        shell: win32.join(
          environmentVariable(env, 'SYSTEMROOT', 'win32') ?? 'C:\\Windows',
          'System32',
          'cmd.exe',
        ),
        env: { ...env, NoDefaultCurrentDirectoryInExePath: '1' },
      }
    : { file, args: [...args], shell: false, env };

// Between SIGTERM and SIGKILL: long enough for a script such as npm run check to kill its own
// children's groups on SIGTERM, short enough that a stop still feels immediate.
const GRACE_MS = 2500;

// taskkill by its full path: a bare name would be looked up through PATH.
const taskkillPath = (): string =>
  join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');

/**
 * Kills a process and every process it started. On Windows through taskkill; elsewhere the
 * process must lead its own process group (spawned with `detached: true`). That group is asked
 * to stop with SIGTERM, so a process in it can end the groups of its own children, and killed
 * with SIGKILL after a grace period.
 */
export const killProcessTree = (pid: number, options: KillTreeOptions = {}): void => {
  const {
    platform = process.platform,
    signal = (target, name) => process.kill(target, name),
    taskkill = (target) => {
      const args = ['/PID', String(target), '/T', '/F'];
      execFile(taskkillPath(), args, { windowsHide: true }, () => {});
    },
    timers = realTimers,
  } = options;
  if (platform === 'win32') {
    taskkill(pid);
    return;
  }
  // The group first; a process that leads no group gets the signal on its own. Gone is fine.
  const tryKill = (target: number, name: NodeJS.Signals): boolean => {
    try {
      signal(target, name);
      return true;
    } catch {
      return false;
    }
  };
  const target = [-pid, pid].find((candidate) => tryKill(candidate, 'SIGTERM'));
  if (target === undefined) return;
  // SIGKILL only where the SIGTERM went: once that is gone, the pid may belong to another
  // process by now.
  timers.set(() => tryKill(target, 'SIGKILL'), GRACE_MS);
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

/**
 * How the runner ended a process it killed: its deadline passed, its signal aborted, or it wrote
 * more than its output limit.
 */
export type Killed = 'timed-out' | 'stopped' | 'too-much-output';

/** The output limit when the caller gives none (ADR 0035). */
export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface ExecOptions {
  cwd: string;
  /** The process's environment; default this process's. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Kills the process and every process it started after this long. */
  timeoutMs?: number | undefined;
  /** Kills the process and every process it started when it aborts. */
  signal?: AbortSignal | undefined;
  /**
   * Kills the process and every process it started when stdout and stderr together pass this
   * many bytes; default DEFAULT_MAX_OUTPUT_BYTES.
   */
  maxOutputBytes?: number | undefined;
  /**
   * On Windows, starts the process inside a kill-on-close Job Object, so a kill also ends the
   * processes whose parent has already exited (ADR 0039). Costs about 0.4 s per call; a process
   * that cannot be held in a job does not start. Ignored elsewhere, where the runner kills the
   * process group.
   */
  jobObject?: boolean | undefined;
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
  /** Set when the runner asked for a pipe to the program's stdin. */
  readonly stdin?: Writable | null | undefined;
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
    options: { cwd: string; env: NodeJS.ProcessEnv; jobObject?: boolean; stdin?: boolean },
  ) => ChildHandle;
  killTree: (pid: number) => void;
  /** Whether `spawn` holds a process in a Job Object when asked to (the real one on Windows). */
  jobObjects?: boolean;
  /**
   * The file a command name runs, or undefined when there is none. The runner spawns what this
   * returns; without it, the name as given.
   */
  resolve?: (file: string, env: NodeJS.ProcessEnv) => string | undefined;
}

// What a process wrote, then the reason it failed.
const withReason = (text: string, error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return text === '' || text.endsWith('\n') ? `${text}${message}` : `${text}\n${message}`;
};

/**
 * A runner that starts programs through the given spawner and collects their output. At the
 * deadline, when the signal aborts, or when the output passes its limit, it kills the whole tree
 * and answers at once, without waiting for output pipes that a surviving grandchild may hold open.
 */
export const execProcessWith =
  (
    { spawn, killTree, resolve, jobObjects = false }: Spawner,
    timers: Timers = realTimers,
  ): ExecProcess =>
  (
    file,
    args,
    {
      cwd,
      env = process.env,
      timeoutMs,
      signal,
      maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
      jobObject = false,
    },
  ) =>
    new Promise((done) => {
      let stdout = '';
      let stderr = '';
      let output = '';
      let outputBytes = 0;
      const ended = (exitCode: number | null, killed?: Killed): ExecResult =>
        killed === undefined
          ? { exitCode, stdout, stderr, output }
          : { exitCode, stdout, stderr, output, killed };
      const failed = (error: unknown): ExecResult => ({
        exitCode: null,
        stdout,
        stderr: withReason(stderr, error),
        output: withReason(output, error),
      });
      if (signal?.aborted) {
        done(ended(null, 'stopped'));
        return;
      }
      const program = resolve === undefined ? file : resolve(file, env);
      if (program === undefined) {
        done(failed(`${file}: not found on PATH (ENOENT)`));
        return;
      }
      let child: ChildHandle;
      try {
        child = spawn(program, [...args], { cwd, env, jobObject });
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
      // Whether the chunk fits within the limit; the one that passes it is dropped (ADR 0035).
      const fits = (chunk: string): boolean => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes <= maxOutputBytes) return true;
        kill('too-much-output');
        return false;
      };
      // Decode as a stream, so a multi-byte character split across chunks stays intact.
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        if (!fits(chunk)) return;
        stdout += chunk;
        output += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        if (!fits(chunk)) return;
        stderr += chunk;
        output += chunk;
      });
      child.on('error', (error) => finish(failed(error)));
      child.on('close', (code) => {
        // Fail closed: a program the helper could not hold in a job did not start (ADR 0039).
        const refused =
          jobObject && jobObjects ? jobObjectRefusal(code, stdout, stderr) : undefined;
        if (refused === undefined) {
          finish(ended(code));
          return;
        }
        const reason = `${program}: cannot run in a Job Object: ${refused}`;
        finish({ exitCode: null, stdout: '', stderr: reason, output: reason });
      });
    });

/** How the runner ended a process it streams: as execProcess, or at a line past its limit. */
export type StreamKilled = Killed | 'line-too-long';

export interface StreamOptions {
  cwd: string;
  /** The process's environment; default this process's. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Kills the process and every process it started after this long. */
  timeoutMs?: number | undefined;
  /** Kills the process and every process it started when it aborts. */
  signal?: AbortSignal | undefined;
  /** As ExecOptions.jobObject (ADR 0039). */
  jobObject?: boolean | undefined;
  /** Written to the program's stdin, which is then closed; without it, stdin is empty. */
  stdin?: string | undefined;
  /** Each line of stdout as it comes, without its line ending (LF or CRLF). */
  onLine: (line: string) => void;
  /** Kills the process and every process it started when one line of stdout passes this. */
  maxLineBytes: number;
  /**
   * Kills the process and every process it started when stderr passes this many bytes; default
   * DEFAULT_MAX_OUTPUT_BYTES.
   */
  maxStderrBytes?: number | undefined;
}

export interface StreamResult {
  /** The exit code; `null` when the process could not start or was killed. */
  exitCode: number | null;
  /** What the process wrote to stderr, then why it failed when it could not start. */
  stderr: string;
  /** Set when the runner killed the process and every process it started. */
  killed?: StreamKilled;
}

export type StreamProcess = (
  file: string,
  args: readonly string[],
  options: StreamOptions,
) => Promise<StreamResult>;

/**
 * A runner that hands a program's stdout to the caller line by line and keeps none of it, so a
 * long stream has no total limit, only one per line (ADR 0046).
 */
export const streamProcessWith =
  (
    { spawn, killTree, resolve, jobObjects = false }: Spawner,
    timers: Timers = realTimers,
  ): StreamProcess =>
  (
    file,
    args,
    {
      cwd,
      env = process.env,
      timeoutMs,
      signal,
      jobObject = false,
      stdin,
      onLine,
      maxLineBytes,
      maxStderrBytes = DEFAULT_MAX_OUTPUT_BYTES,
    },
  ) =>
    new Promise((done) => {
      let stderr = '';
      let stderrBytes = 0;
      const failed = (error: unknown): StreamResult => ({
        exitCode: null,
        stderr: withReason(stderr, error),
      });
      if (signal?.aborted) {
        done({ exitCode: null, stderr, killed: 'stopped' });
        return;
      }
      const program = resolve === undefined ? file : resolve(file, env);
      if (program === undefined) {
        done(failed(`${file}: not found on PATH (ENOENT)`));
        return;
      }
      let child: ChildHandle;
      try {
        child = spawn(program, [...args], { cwd, env, jobObject, stdin: stdin !== undefined });
      } catch (error) {
        done(failed(error));
        return;
      }
      let finished = false;
      const finish = (result: StreamResult): void => {
        if (finished) return;
        finished = true;
        if (timer !== undefined) timers.clear(timer);
        signal?.removeEventListener('abort', stop);
        done(result);
      };
      const kill = (killed: StreamKilled): void => {
        if (finished) return;
        if (child.pid !== undefined) killTree(child.pid);
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ exitCode: null, stderr, killed });
      };
      const stop = (): void => kill('stopped');
      const timer =
        timeoutMs === undefined ? undefined : timers.set(() => kill('timed-out'), timeoutMs);
      signal?.addEventListener('abort', stop, { once: true });
      // A program that exits before reading its input makes the write fail (EPIPE); how it ended
      // says more than that.
      if (stdin !== undefined && child.stdin) {
        child.stdin.on('error', () => {});
        child.stdin.end(stdin);
      }
      // The helper's refusal comes alone, first, before the program exists (ADR 0039): a first
      // line that looks like it waits until the process ends or writes more.
      let mayBeRefusal = jobObject && jobObjects;
      let held: string | undefined;
      const deliver = (line: string): void => {
        if (mayBeRefusal) {
          mayBeRefusal = false;
          if (jobObjectRefusal(JOB_OBJECT_FAILED, line, '') !== undefined) {
            held = line;
            return;
          }
        }
        if (held !== undefined) {
          const first = held;
          held = undefined;
          onLine(first);
          if (finished) return;
        }
        onLine(line);
      };
      // The line being read, and its bytes. A CR may still come before its LF, which the limit
      // does not count.
      let pending = '';
      let pendingBytes = 0;
      const endLine = (text: string, bytes: number): void => {
        const line = text.endsWith('\r') ? text.slice(0, -1) : text;
        if (bytes - (text.length - line.length) > maxLineBytes) kill('line-too-long');
        else deliver(line);
      };
      // Decode as a stream, so a multi-byte character split across chunks stays intact.
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        let start = 0;
        while (!finished) {
          const end = chunk.indexOf('\n', start);
          const piece = end === -1 ? chunk.slice(start) : chunk.slice(start, end);
          pending += piece;
          pendingBytes += Buffer.byteLength(piece);
          if (end === -1) {
            if (pendingBytes > maxLineBytes + 1) kill('line-too-long');
            return;
          }
          const [text, bytes] = [pending, pendingBytes];
          pending = '';
          pendingBytes = 0;
          endLine(text, bytes);
          start = end + 1;
        }
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > maxStderrBytes) kill('too-much-output');
        else stderr += chunk;
      });
      child.on('error', (error) => finish(failed(error)));
      child.on('close', (code) => {
        if (pendingBytes > 0) endLine(pending, pendingBytes);
        if (finished) return;
        // Fail closed: a program the helper could not hold in a job did not start (ADR 0039).
        const refused = held === undefined ? undefined : jobObjectRefusal(code, held, stderr);
        if (refused !== undefined) {
          finish({ exitCode: null, stderr: `${program}: cannot run in a Job Object: ${refused}` });
          return;
        }
        if (held !== undefined) onLine(held);
        finish({ exitCode: code, stderr });
      });
    });

// Job Objects are Windows's; elsewhere the runner kills the process group.
const jobObjectsHere = process.platform === 'win32';

/** The real spawner. Unit tests use a fake one instead (ADR 0021). */
export const processSpawner: Spawner = {
  spawn: (file, args, { cwd, env, jobObject = false, stdin = false }) => {
    const command = spawnCommand(file, args, process.platform, env);
    const start =
      jobObjectsHere && jobObject ? jobObjectCommand(command, cwd) : { ...command, cwd };
    const options = {
      cwd: start.cwd,
      env: start.env,
      shell: start.shell,
      windowsHide: true,
      ...killableSpawnOptions(),
    };
    return stdin
      ? spawn(start.file, start.args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(start.file, start.args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  },
  killTree: killProcessTree,
  jobObjects: jobObjectsHere,
  // Never the working directory or a relative PATH folder, where a repository could plant its
  // own git.exe (#12).
  resolve: (file, env) => resolveExecutable(file, { env }),
};

/** The real runner. Unit tests use execProcessWith with a fake spawner instead (ADR 0021). */
export const execProcess: ExecProcess = execProcessWith(processSpawner);

/** The real line-by-line runner. Unit tests use streamProcessWith with a fake spawner. */
export const streamProcess: StreamProcess = streamProcessWith(processSpawner);

// The narrower runner the scripts' shells inject (ADR 0021): the exit code and the output
// together. Unit tests pass a fake one.
export interface ProcessOutcome {
  /** The exit code; `null` when the process could not start or was killed. */
  exitCode: number | null;
  output: string;
  killed?: Killed;
}

export type RunOptions = Pick<ExecOptions, 'timeoutMs' | 'signal' | 'maxOutputBytes' | 'jobObject'>;

export type RunProcess = (
  file: string,
  args: string[],
  cwd: string,
  options?: RunOptions,
) => Promise<ProcessOutcome>;

export const runProcessThrough =
  (exec: ExecProcess): RunProcess =>
  async (file, args, cwd, options = {}) => {
    const { exitCode, output, killed } = await exec(file, args, { ...options, cwd });
    return killed === undefined ? { exitCode, output } : { exitCode, output, killed };
  };

/** The real runner, with the output together. */
export const spawnProcess: RunProcess = runProcessThrough(execProcess);

// A byte count as a person would write it: 4 MiB, 64 KiB, 1500 bytes.
const inUnits = (bytes: number): string => {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes} bytes`;
};

/** Why the runner killed a process, for a message; undefined when it ended by itself. */
export const whyKilled = (
  killed: Killed | undefined,
  timeoutMs: number,
  maxOutputBytes: number = DEFAULT_MAX_OUTPUT_BYTES,
): string | undefined => {
  switch (killed) {
    case undefined:
      return undefined;
    case 'timed-out':
      return `timed out after ${timeoutMs / 1000} s`;
    case 'stopped':
      return 'stopped';
    case 'too-much-output':
      return `wrote more than ${inUnits(maxOutputBytes)} of output`;
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
