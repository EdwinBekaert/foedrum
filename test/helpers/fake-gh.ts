// A fake `gh` for the GitHub client's tests (ADR 0073): a process runner that answers each
// `gh api --include` call the way gh prints an answer, from a fake `fetch` or from captured
// output, and records the calls. No process starts and nothing reaches the network (ADR 0021).

import type { ExecOptions, ExecProcess, ExecResult } from '../../src/platform/processes.ts';

/** One call of the fake `gh`. */
export interface GhCall {
  file: string;
  args: readonly string[];
  options: ExecOptions;
}

/** What gh printed and how it exited, as a test captured it. */
export interface GhOutput {
  stdout: string;
  stderr?: string;
  exitCode: number | null;
}

/** The value after `flag` in `args`, the first time it comes. */
export const flagValue = (args: readonly string[], flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};

/** Every value after `flag` in `args`. */
const flagValues = (args: readonly string[], flag: string): string[] =>
  args.flatMap((arg, i) => (arg === flag && i + 1 < args.length ? [args[i + 1] ?? ''] : []));

/** The API root gh asks for `hostname`, as gh works it out. */
const apiRoot = (hostname: string): string =>
  hostname === 'github.com'
    ? 'https://api.github.com'
    : hostname === 'github.localhost'
      ? 'http://api.github.localhost'
      : `https://${hostname}/api/v3`;

/** The URL gh asks for `path` on `hostname`: GraphQL has an endpoint of its own. */
const urlOf = (hostname: string, path: string): string =>
  path === 'graphql'
    ? hostname === 'github.com'
      ? 'https://api.github.com/graphql'
      : `${apiRoot(hostname).replace(/\/v3$/, '')}/graphql`
    : `${apiRoot(hostname)}/${path.replace(/^\//, '')}`;

const result = (stdout: string, stderr: string, exitCode: number | null): ExecResult => ({
  exitCode,
  stdout,
  stderr,
  output: `${stdout}${stderr}`,
});

const killed = (why: 'timed-out' | 'stopped' | 'too-much-output'): ExecResult => ({
  ...result('', '', null),
  killed: why,
});

/** gh's printout of a response with `--include`: the status line, the headers, then the body. */
export const ghPrintout = async (response: Response): Promise<GhOutput> => {
  const lines = [...response.headers.entries()].map(([name, value]) => `${name}: ${value}\r\n`);
  const statusText = response.statusText === '' ? '' : ` ${response.statusText}`;
  const body = await response.text();
  const stdout = `HTTP/1.1 ${response.status}${statusText}\n${lines.join('')}\r\n${body}`;
  // gh exits 1 for any status of 300 or more, after printing the answer.
  return response.status >= 300
    ? { stdout, stderr: `gh: HTTP ${response.status}\n`, exitCode: 1 }
    : { stdout, exitCode: 0 };
};

/**
 * A `gh` that answers each `gh api` call by asking `fetch` for the request it names: the method,
 * the `-H` headers, the path on the host's API and the body on stdin. It honours the runner's
 * timeout, signal and output limit the way the real runner does.
 */
export const ghOver = (fetch: typeof globalThis.fetch) => {
  const calls: GhCall[] = [];
  const exec: ExecProcess = async (file, args, options) => {
    calls.push({ file, args, options });
    const hostname = flagValue(args, '--hostname') ?? 'github.com';
    const method = flagValue(args, '--method') ?? 'GET';
    const headers = Object.fromEntries(
      flagValues(args, '-H').map((header) => {
        const colon = header.indexOf(':');
        return [header.slice(0, colon).trim(), header.slice(colon + 1).trim()];
      }),
    );
    const path = args.at(-1) === '-' ? (args.at(-3) ?? '') : (args.at(-1) ?? '');
    const controller = new AbortController();
    if (options.signal?.aborted === true) return killed('stopped');
    let why: 'timed-out' | 'stopped' | undefined;
    const stop = () => {
      why = 'stopped';
      controller.abort(options.signal?.reason);
    };
    options.signal?.addEventListener('abort', stop, { once: true });
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            why = 'timed-out';
            controller.abort(new Error('timed out'));
          }, options.timeoutMs);
    try {
      const response = await fetch(urlOf(hostname, path), {
        method,
        headers,
        ...(options.stdin === undefined ? {} : { body: options.stdin }),
        signal: controller.signal,
      });
      const printed = await ghPrintout(response);
      const bytes = Buffer.byteLength(printed.stdout) + Buffer.byteLength(printed.stderr ?? '');
      if (options.maxOutputBytes !== undefined && bytes > options.maxOutputBytes) {
        return killed('too-much-output');
      }
      return result(printed.stdout, printed.stderr ?? '', printed.exitCode);
    } catch (error) {
      if (why !== undefined) return killed(why);
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', stop);
    }
  };
  return { exec, calls };
};

/** A `gh` that prints each captured output in turn, recording the calls. */
export const ghAnswering = (outputs: GhOutput[]) => {
  const calls: GhCall[] = [];
  const exec: ExecProcess = async (file, args, options) => {
    calls.push({ file, args, options });
    const next = outputs.shift();
    if (next === undefined) throw new Error(`no output for gh ${args.join(' ')}`);
    return result(next.stdout, next.stderr ?? '', next.exitCode);
  };
  return { exec, calls };
};
