// Kills what a test that starts a sleeping child may leave behind, by PID: the pid the child
// wrote, and every process whose command line names the test's own marker (its pid file). A
// child killed before it ran, or still being created when git's tree was killed, writes no pid,
// and on Windows such a process can sit with no CPU for good.

import { existsSync, readFileSync } from 'node:fs';
import { execProcess, isPidAlive } from '../../src/platform/processes.ts';

/** The pids of the processes whose command line contains `marker`, this process left out. */
const pidsNaming = async (marker: string): Promise<number[]> => {
  const { stdout } =
    process.platform === 'win32'
      ? await execProcess(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:FOEDRUM_MARKER) } | ForEach-Object { $_.ProcessId }',
          ],
          {
            cwd: process.cwd(),
            env: { ...process.env, FOEDRUM_MARKER: marker },
            timeoutMs: 30_000,
          },
        )
      : await execProcess('ps', ['-A', '-o', 'pid=,args='], {
          cwd: process.cwd(),
          timeoutMs: 30_000,
        });
  const lines = stdout.split(/\r?\n/);
  const named =
    process.platform === 'win32' ? lines : lines.filter((line) => line.includes(marker));
  return named
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
};

/** The pid a child wrote to `pidFile`, or undefined while it has written none. */
export const pidIn = (pidFile: string): number | undefined => {
  if (!existsSync(pidFile)) return undefined;
  const written = Number(readFileSync(pidFile, 'utf8'));
  return Number.isInteger(written) && written > 0 ? written : undefined;
};

/** Kills the child that wrote `pidFile`, and any process that names `pidFile`, if still alive. */
export const killLeftovers = async (pidFile: string): Promise<void> => {
  const pids = new Set(await pidsNaming(pidFile));
  const written = pidIn(pidFile);
  if (written !== undefined) pids.add(written);
  for (const pid of pids) {
    if (!isPidAlive(pid)) continue;
    try {
      process.kill(pid);
    } catch {
      // It ended between the check and the kill.
    }
  }
};
