// The real brewer runner (ADR 0003, ADR 0028, ADR 0047): runs an attempt as one `claude` process
// with the runner's own settings file, its prompt on stdin, inside a Job Object on Windows, and
// reads its stream line by line. What it saw goes through settleAttempt, as with the fake.

import type { AttemptStart, BrewerRunner } from '../engine/brewer-runner.ts';
import type { StreamProcess } from '../platform/processes.ts';
import type { AttemptSettings } from '../schemas/attempt-settings.ts';
import type { AttemptPermissions } from './attempt-settings.ts';
import type { ClaudeCall } from './claude-command.ts';
import type { BrewerPrompt } from './prompt.ts';

/** Everything one attempt needs, prepared by the engine (its worktree, prompt and session). */
export interface ClaudeAttemptPlan {
  /** The attempt's worktree; the out doc's path is relative to it. */
  cwd: string;
  /** The brewer's environment (buildBrewerEnv, ADR 0028). */
  env: NodeJS.ProcessEnv;
  /** Only a prompt from assembleBrewerPrompt (ADR 0041); it goes on stdin. */
  prompt: BrewerPrompt;
  call: Omit<ClaudeCall, 'settingsFile'>;
  permissions: AttemptPermissions;
  /** Where the runner writes the attempt's settings file. */
  settingsFile: string;
}

/** An out doc as the runner found it. */
export type OutDocRead =
  | { kind: 'text'; text: string }
  | { kind: 'missing' }
  | { kind: 'unread'; reason: string };

export interface ClaudeRunnerDeps {
  /** The `claude` program to start. */
  claude: string;
  plan: (attempt: AttemptStart) => Promise<ClaudeAttemptPlan>;
  stream: StreamProcess;
  files: {
    writeSettings: (file: string, settings: AttemptSettings) => void;
    readOutDoc: (file: string, maxBytes: number) => OutDocRead;
  };
  now: () => Date;
}

/** Reads an out doc of at most `maxBytes`, and only a regular file. */
export function readOutDocFile(_file: string, _maxBytes: number): OutDocRead {
  throw new Error('not implemented');
}

/** A brewer runner over the given stream process and files; unit tests pass fakes. */
export function claudeBrewerRunnerWith(_deps: ClaudeRunnerDeps): BrewerRunner {
  throw new Error('not implemented');
}
