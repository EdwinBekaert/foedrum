// Holding a process and everything it starts in a kill-on-close Job Object on Windows (#92,
// ADR 0039), through a PowerShell helper started by its full path: job-object.ps1. Node has no
// way to create a job itself, and its own job lets grandchildren break away.

import { readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { environmentVariable } from './executables.ts';
import type { SpawnCommand } from './processes.ts';

/** The exit code of the helper when it could not start the program inside a job. */
const JOB_OBJECT_FAILED = 125;

// The line the helper writes, alone on stdout, when it could not start the program in a job.
const REFUSAL = 'foedrum job object: ';

/** One argument quoted as Windows programs read their command line (CommandLineToArgvW). */
export const windowsArgument = (argument: string): string => {
  // node's own quoting (libuv's quote_cmd_arg): backslashes double only before a quote and at
  // the end, where the closing quote follows them.
  if (argument === '') return '""';
  if (!/[ \t"]/.test(argument)) return argument;
  if (!/["\\]/.test(argument)) return `"${argument}"`;
  return `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
};

/**
 * An environment as the block CreateProcessW takes with CREATE_UNICODE_ENVIRONMENT: name=value
 * entries sorted by name without regard to case, each ended by NUL, and one more NUL.
 */
export const windowsEnvironmentBlock = (env: NodeJS.ProcessEnv): string => {
  // As node's spawn on Windows: of names that differ only in case, the first in sorted order.
  const seen = new Set<string>();
  const entries: [string, string][] = [];
  for (const name of Object.keys(env).sort()) {
    const value = env[name];
    if (value === undefined || seen.has(name.toUpperCase())) continue;
    seen.add(name.toUpperCase());
    entries.push([name, value]);
  }
  const byName = ([a]: [string, string], [b]: [string, string]): number =>
    a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0;
  return `${entries
    .sort(byName)
    .map(([name, value]) => `${name}=${value}`)
    .join('\0')}\0\0`;
};

/** What the helper passes to CreateProcess: the file it starts, and its whole command line. */
export interface JobObjectLine {
  application: string;
  line: string;
}

/** The application and command line that start a command as node's spawn would. */
export const jobObjectLine = ({ file, args, shell }: SpawnCommand): JobObjectLine =>
  shell === false
    ? { application: file, line: [file, ...args].map(windowsArgument).join(' ') }
    : // As node runs a shell: the line checked and quoted by windowsCommandLine (ADR 0031).
      { application: shell, line: `${windowsArgument(shell)} /d /s /c "${file}"` };

/** How to start the helper for a command: PowerShell, its arguments, environment and directory. */
export interface JobObjectSpawn extends SpawnCommand {
  cwd: string;
}

let helper: string | undefined;

// The helper's script without its comments and indentation, which only lengthen the command line.
const helperScript = (): string => {
  helper ??= readFileSync(new URL('./job-object.ps1', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && (!line.startsWith('#') || line === '# Foedrum: inputs'))
    .join('\n');
  return helper;
};

// The helper's variable that carries the program's environment block, as base64 of its UTF-8.
const JOB_ENVIRONMENT = 'FOEDRUM_JOB_ENVIRONMENT';

// A value as base64 of its UTF-8, so no quote, $ or backtick in it can change the script; the
// helper decodes it with Read-Input, defined once before the inputs.
const DECODE =
  'function Read-Input($b) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)) }';
const input = (name: string, value: string): string =>
  `$${name} = Read-Input '${Buffer.from(value, 'utf8').toString('base64')}'`;

/** Starts the command through the helper, which runs it in `cwd` inside a kill-on-close job. */
export const jobObjectCommand = (command: SpawnCommand, cwd: string): JobObjectSpawn => {
  const { application, line } = jobObjectLine(command);
  // Absolute, as node's spawn would resolve them: PowerShell runs in System32, which must never
  // decide where the program runs or which file it is.
  const directory = win32.resolve(cwd);
  const inputs = [
    DECODE,
    input('file', win32.resolve(directory, application)),
    input('line', line),
    input('cwd', directory),
    // The program's environment block, from the helper's own environment (see below).
    `$environment = Read-Input $env:${JOB_ENVIRONMENT}`,
  ];
  const script = helperScript().replace('# Foedrum: inputs', inputs.join('\n'));
  const system32 = win32.join(
    environmentVariable(command.env, 'SYSTEMROOT', 'win32') ?? 'C:\\Windows',
    'System32',
  );
  return {
    // By its full path, as cmd.exe and taskkill are: never through PATH or the working directory.
    file: win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    // An encoded command, which no execution policy blocks and no quoting can break.
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    shell: false,
    // The program gets exactly the caller's environment as a block of its own, never the
    // helper's, to which Windows PowerShell adds PSModulePath, PATHEXT and whatever a later version
    // adds. The block travels in the helper's environment, where it has no practical limit; on
    // the command line it would take about 3.6 characters of the 32,767 for each of its own.
    env: {
      ...command.env,
      [JOB_ENVIRONMENT]: Buffer.from(windowsEnvironmentBlock(command.env), 'utf8').toString(
        'base64',
      ),
    },
    // PowerShell runs where nothing of a repository can take part; the program runs in `cwd`.
    cwd: system32,
  };
};

/**
 * Why the helper could not start the program inside a job, from how it ended; `undefined` when
 * the program ran. Only the helper writes the refusal, alone and before the program starts, after
 * the byte order mark Windows PowerShell may put first.
 */
export const jobObjectRefusal = (
  exitCode: number | null,
  stdout: string,
  stderr: string,
): string | undefined => {
  const text = stdout.replace(/^﻿/, '');
  return exitCode === JOB_OBJECT_FAILED && stderr === '' && text.startsWith(REFUSAL)
    ? text.slice(REFUSAL.length).trim()
    : undefined;
};
