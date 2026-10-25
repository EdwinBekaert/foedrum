// Keeping the machine awake while `brew` or `serve` has an attempt running (#476, ADR 0195): each
// platform's built-in way, held by a helper process that watches Foedrum's process id, so a killed
// Foedrum lets the hold go. The idle timer is held off, and the display may still turn off; on
// Linux the lock on sleep also holds off a suspend the user asks for.

import { win32 } from 'node:path';
import { environmentVariable } from './executables.ts';
import { type ExecProcess, realTimers, type Timers } from './processes.ts';

/** How this machine can be kept awake, or why it cannot. */
export type AwakeMechanism =
  /** Windows PowerShell calls SetThreadExecutionState and waits on Foedrum's process. */
  | { kind: 'SetThreadExecutionState'; program: string }
  /** `caffeinate -i -w <pid>` on macOS. */
  | { kind: 'caffeinate'; program: string }
  /** `systemd-inhibit` holds logind's idle and sleep lock while `tail` waits on Foedrum's process. */
  | { kind: 'systemd-inhibit'; program: string; tail: string }
  | { kind: 'none'; why: string };

export interface AwakeMechanismInputs {
  platform: NodeJS.Platform;
  /** The file a command name runs, or `undefined` when it is not on PATH. */
  resolve: (name: string) => string | undefined;
  env: NodeJS.ProcessEnv;
  /** Whether a path exists: on Linux, /run/systemd/system says systemd runs (sd_booted). */
  exists: (path: string) => boolean;
}

/** The mechanism this machine has: a program found by its full path, or none with why. */
export const awakeMechanism = ({
  platform,
  resolve,
  env,
  exists,
}: AwakeMechanismInputs): AwakeMechanism => {
  switch (platform) {
    case 'win32': {
      // By its full path, as the Job Object helper is (ADR 0039): never through PATH.
      const root = environmentVariable(env, 'SYSTEMROOT', 'win32') ?? 'C:\\Windows';
      const program = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      return { kind: 'SetThreadExecutionState', program };
    }
    case 'darwin': {
      const program = resolve('caffeinate');
      return program === undefined
        ? { kind: 'none', why: 'no caffeinate on PATH' }
        : { kind: 'caffeinate', program };
    }
    case 'linux': {
      const program = resolve('systemd-inhibit');
      if (program === undefined) return { kind: 'none', why: 'no systemd-inhibit on PATH' };
      const tail = resolve('tail');
      if (tail === undefined) return { kind: 'none', why: 'no tail on PATH' };
      // As sd_booted tells: without a running systemd, logind takes no lock.
      if (!exists('/run/systemd/system')) return { kind: 'none', why: 'systemd is not running' };
      return { kind: 'systemd-inhibit', program, tail };
    }
    default:
      return { kind: 'none', why: `Foedrum knows no way on ${platform}` };
  }
};

/** The helper's program and arguments, started with no shell. */
export interface AwakeCommand {
  file: string;
  args: string[];
}

// The Windows helper: SetThreadExecutionState through a P/Invoke method emitted in memory, as the
// Job Object helper calls kernel32 (Add-Type would compile C# into the temp folder), with no
// cmdlet, so no module loads (#177). The request lasts as long as this thread, which then waits
// on Foedrum's process; when that process is gone, or the helper is killed, the request ends.
const windowsHelper = (pid: number): string =>
  [
    "$PSModuleAutoLoadingPreference = 'None'",
    "$ErrorActionPreference = 'Stop'",
    "$module = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('FoedrumKeepAwake'), 'Run').DefineDynamicModule('FoedrumKeepAwake')",
    "$type = $module.DefineType('Kernel32', 'Public,Class')",
    '$dllImport = [Runtime.InteropServices.DllImportAttribute]',
    "$import = [Reflection.Emit.CustomAttributeBuilder]::new($dllImport.GetConstructor([string]), [object[]]@('kernel32.dll'))",
    "$type.DefineMethod('SetThreadExecutionState', 'Public,Static,PinvokeImpl', [uint32], [Type[]]@([uint32])).SetCustomAttribute($import)",
    '$k = $type.CreateType()',
    // In decimal: Windows PowerShell reads the hex literal as a negative Int32.
    '# ES_CONTINUOUS | ES_SYSTEM_REQUIRED = 0x80000001; never ES_DISPLAY_REQUIRED',
    'if ($k::SetThreadExecutionState([uint32]2147483649) -eq 0) { exit 1 }',
    `[Diagnostics.Process]::GetProcessById(${pid}).WaitForExit()`,
  ].join('\n');

/** The helper that holds the machine awake until the process `pid` ends; none without a mechanism. */
export const awakeCommand = (mechanism: AwakeMechanism, pid: number): AwakeCommand | undefined => {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`not a process id: ${pid}`);
  switch (mechanism.kind) {
    case 'SetThreadExecutionState':
      return {
        file: mechanism.program,
        // An encoded command, which no execution policy blocks and no quoting can break.
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(windowsHelper(pid), 'utf16le').toString('base64'),
        ],
      };
    case 'caffeinate':
      return { file: mechanism.program, args: ['-i', '-w', String(pid)] };
    case 'systemd-inhibit':
      return {
        file: mechanism.program,
        args: [
          '--what=idle:sleep',
          '--who=foedrum',
          '--why=foedrum brewing',
          '--mode=block',
          mechanism.tail,
          `--pid=${pid}`,
          '-f',
          '/dev/null',
        ],
      };
    case 'none':
      return undefined;
    default: {
      const unknown: never = mechanism;
      throw new Error(`unknown keep-awake mechanism ${JSON.stringify(unknown)}`);
    }
  }
};

/** What `brew` and `serve` tell the hold: attempts that start and end, and their own end. */
export interface AwakeHold {
  attemptStarted(): void;
  attemptEnded(): void;
  /** Lets the hold go for good: the command ends. */
  release(): void;
}

export interface KeepAwakeOptions {
  /** The helper to start; `undefined` starts nothing. */
  command: AwakeCommand | undefined;
  exec: ExecProcess;
  /** Where the helper runs. */
  cwd: string;
  /** The timer of the minute after the last attempt; default the real ones. */
  timers?: Timers;
}

// The helpers print nothing; anything past this is not theirs to say, and stops them.
const HELPER_OUTPUT_BYTES = 64 * 1024;

/**
 * How long the hold outlasts the last attempt: the next step of a batch starts on a later tick, and
 * a machine idle past its timer could sleep in between (ADR 0195).
 */
export const HOLD_GRACE_MS = 60_000;

/**
 * Holds the machine awake from the first running attempt until a minute after none runs, or until
 * `release`.
 */
export const keepAwake = ({
  command,
  exec,
  cwd,
  timers = realTimers,
}: KeepAwakeOptions): AwakeHold => {
  let running = 0;
  let released = false;
  // The helper that holds the machine now, stopped through its signal with its whole tree.
  let helper: AbortController | undefined;
  // The minute after the last attempt, while it runs.
  let grace: unknown;
  const callOff = (): void => {
    if (grace === undefined) return;
    timers.clear(grace);
    grace = undefined;
  };
  const stop = (): void => {
    callOff();
    helper?.abort();
    helper = undefined;
  };
  return {
    attemptStarted: () => {
      running++;
      callOff();
      if (command === undefined || released || helper !== undefined) return;
      const started = new AbortController();
      helper = started;
      // A helper that ended on its own is started again by the next attempt.
      const ended = (): void => {
        if (helper === started) helper = undefined;
      };
      // No deadline: it holds until no attempt runs, the command ends, or Foedrum's process does.
      void exec(command.file, command.args, {
        cwd,
        signal: started.signal,
        maxOutputBytes: HELPER_OUTPUT_BYTES,
      }).then(ended, ended);
    },
    attemptEnded: () => {
      running = Math.max(0, running - 1);
      if (running === 0 && helper !== undefined && grace === undefined) {
        grace = timers.set(stop, HOLD_GRACE_MS);
      }
    },
    release: () => {
      released = true;
      stop();
    },
  };
};
