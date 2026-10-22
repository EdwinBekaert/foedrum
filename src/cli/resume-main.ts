// `foedrum resume` on the real machine (ADR 0126): serve's setup of the Brewery in the working
// directory, its worktrees, the session's transcript under Claude Code's config directory, and
// claude in the foreground with the terminal. main.ts runs it through the command layer; the logic
// is resume.ts's, tested with fakes.

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, release } from 'node:os';
import { dirname, join } from 'node:path';
import { writeAttemptSettings } from '../brewers/attempt-settings.ts';
import { readBreweryFiles } from '../engine/brewery-files.ts';
import { openSqliteEventStore } from '../engine/sqlite-event-store.ts';
import { environmentVariable, resolveExecutable } from '../platform/executables.ts';
import { execProcess, foregroundProcess } from '../platform/processes.ts';
import type { ResumeCommand } from '../schemas/commands.ts';
import { ownGitDirsRoot } from '../workspace/attempt-worktrees.ts';
import { openAttemptWorktrees, worktreeClonePath } from '../workspace/attempt-worktrees-git.ts';
import { runGit } from '../workspace/git.ts';
import { diagnose, githubHostOfConfig } from './doctor.ts';
import { type DoctorShell, gatherDoctorFacts } from './doctor-facts.ts';
import { runResume } from './resume.ts';
import type { CliResult } from './run.ts';
import { serveSetup } from './serve-config.ts';

const readIfThere = (path: string): string | undefined =>
  existsSync(path) ? readFileSync(path, 'utf8') : undefined;

/**
 * Whether a transcript `<id>.jsonl` is in any project folder of Claude Code's config directory:
 * `CLAUDE_CONFIG_DIR`, else `.claude` in the home folder (ADR 0116).
 */
const sessionFound = (id: string): boolean => {
  const config =
    environmentVariable(process.env, 'CLAUDE_CONFIG_DIR', process.platform) ??
    join(homedir(), '.claude');
  const projects = join(config, 'projects');
  if (!existsSync(projects)) return false;
  return readdirSync(projects, { withFileTypes: true }).some(
    (folder) => folder.isDirectory() && existsSync(join(projects, folder.name, `${id}.jsonl`)),
  );
};

/** Runs `foedrum resume` in the Brewery checkout `cwd`; doctor's facts come through `options`. */
export const resumeFromCheckout = async (
  cwd: string,
  input: ResumeCommand,
  options?: Partial<Pick<DoctorShell, 'exec' | 'resolve'>>,
): Promise<CliResult> => {
  const { exec = execProcess, resolve = resolveExecutable } = options ?? {};
  const config = readIfThere(join(cwd, 'foedrum.jsonc'));
  const setup = async () => {
    const facts = await gatherDoctorFacts({
      exec,
      resolve,
      platform: process.platform,
      kernelRelease: release(),
      node: process.versions.node,
      execPath: process.execPath,
      cwd,
      githubHost: githubHostOfConfig(config),
    });
    return serveSetup({
      root: cwd,
      home: homedir(),
      platform: process.platform,
      env: process.env,
      files: {
        config,
        local: readIfThere(join(cwd, '.foedrum', 'local.jsonc')),
        models: readIfThere(join(cwd, 'models.jsonc')),
        brewery: readBreweryFiles(cwd),
      },
      diagnosis: diagnose(facts),
    });
  };
  // Ctrl+C is claude's while it runs; foedrum waits to let the leases go.
  const ignore = () => {};
  return runResume(input, {
    cwd,
    openStore: (path) => (existsSync(path) ? openSqliteEventStore(path) : undefined),
    setup,
    worktrees: async (repository, workRoot) => {
      const { repo } = repository;
      // The clone the attempt's worktree was added to, a managed one included: it ran there.
      // recreate fetches nothing, so the remote is named only as serve's shell names it.
      return openAttemptWorktrees({
        git: runGit,
        workRoot,
        repo,
        clone: worktreeClonePath(workRoot, repository),
        own: { url: `https://github.com/${repo}.git`, root: ownGitDirsRoot(workRoot, repo) },
      });
    },
    sessionFound,
    writeSettings: (file, settings) => {
      mkdirSync(dirname(file), { recursive: true });
      writeAttemptSettings(file, settings);
    },
    nested:
      environmentVariable(process.env, 'CLAUDE_CODE_CHILD_SESSION', process.platform) === '1' ||
      !process.stdin.isTTY,
    claude: async (program, args, folder) => {
      process.on('SIGINT', ignore);
      try {
        return await foregroundProcess(program, args, folder);
      } finally {
        process.off('SIGINT', ignore);
      }
    },
    now: () => new Date(),
    heartbeat: (everyMs, beat) => {
      const timer = setInterval(beat, everyMs);
      return () => clearInterval(timer);
    },
    pid: process.pid,
  });
};
