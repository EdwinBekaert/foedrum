// Claude Code PreToolUse hook: runs `npm run check` before `git push` and `gh pr create`.
// Wired in .claude/settings.json as `npm run --silent hook:gate`, so npm provides npm_execpath
// and the check runs without a shell on every platform.
// Exit 0 lets the tool call through; exit 2 blocks it and shows stderr to Claude.

import { spawn } from 'node:child_process';
import { win32 } from 'node:path';

export interface CheckResult {
  ok: boolean;
  output: string;
}

export type RunCheck = (cwd: string) => Promise<CheckResult>;

export interface HookResult {
  exitCode: 0 | 2;
  stderr: string;
}

const MAX_OUTPUT_CHARS = 4000;
const COMMAND_SEPARATORS = /&&|\|\||[;&|\r\n(){}]/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

// win32.basename accepts both separators, so this works for Windows and POSIX paths.
const programName = (token: string): string =>
  win32
    .basename(token)
    .toLowerCase()
    .replace(/\.exe$/, '');

const tokenize = (segment: string): string[] => {
  const tokens = segment
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^["']+|["']+$/g, ''))
    .filter((token) => token !== '');
  while (tokens[0] !== undefined && ENV_ASSIGNMENT.test(tokens[0])) tokens.shift();
  return tokens;
};

const isGitPush = (args: string[]): boolean => {
  let i = 0;
  while (args[i]?.startsWith('-')) i += GIT_OPTIONS_WITH_VALUE.has(args[i] ?? '') ? 2 : 1;
  return args[i] === 'push';
};

const isGhPrCreate = (args: string[]): boolean => {
  const [group, action] = args.filter((arg) => !arg.startsWith('-'));
  return group === 'pr' && (action === 'create' || action === 'new');
};

export const isGatedCommand = (command: string): boolean =>
  command.split(COMMAND_SEPARATORS).some((segment) => {
    const [program, ...args] = tokenize(segment);
    if (program === undefined) return false;
    switch (programName(program)) {
      case 'git':
        return isGitPush(args);
      case 'gh':
        return isGhPrCreate(args);
      default:
        return false;
    }
  });

export const forbiddenReason = (_command: string): string | undefined => undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const lastChars = (text: string): string =>
  text.length > MAX_OUTPUT_CHARS ? `…\n${text.slice(-MAX_OUTPUT_CHARS)}` : text;

export const precheck = async (input: string, runCheck: RunCheck): Promise<HookResult> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.replace(/^﻿/, ''));
  } catch {
    return { exitCode: 2, stderr: 'precheck: could not parse the hook input as JSON.\n' };
  }
  if (!isRecord(parsed)) {
    return { exitCode: 2, stderr: 'precheck: the hook input is not a JSON object.\n' };
  }

  const command = isRecord(parsed.tool_input) ? parsed.tool_input.command : undefined;
  if (typeof command !== 'string' || !isGatedCommand(command)) return { exitCode: 0, stderr: '' };

  const cwd = typeof parsed.cwd === 'string' ? parsed.cwd : process.cwd();
  const { ok, output } = await runCheck(cwd);
  if (ok) return { exitCode: 0, stderr: '' };
  return {
    exitCode: 2,
    stderr: `npm run check failed, so this command was blocked. Fix the failures and try again.\n\n${lastChars(output.trim())}\n`,
  };
};

const runNpmCheck: RunCheck = (cwd) =>
  new Promise((resolve) => {
    const npmCli = process.env.npm_execpath;
    if (npmCli === undefined || npmCli === '') {
      resolve({
        ok: false,
        output: 'npm_execpath is not set: run this hook as `npm run --silent hook:gate`.',
      });
      return;
    }
    const child = spawn(process.execPath, [npmCli, 'run', 'check'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk: Buffer): void => {
      output += chunk.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => resolve({ ok: false, output: error.message }));
    child.on('close', (code) => resolve({ ok: code === 0, output }));
  });

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

if (import.meta.main) {
  const { exitCode, stderr } = await precheck(await readStdin(), runNpmCheck);
  if (stderr !== '') process.stderr.write(stderr);
  process.exitCode = exitCode;
}
