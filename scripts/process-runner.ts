// The process runner the scripts' shells inject (ADR 0021) is the platform layer's: it starts a
// program without a shell, collects its exit code and output, and kills its whole tree at the
// deadline or when stopped. Unit tests pass a fake runner instead.

export {
  type ProcessOutcome,
  type RunOptions,
  type RunProcess,
  spawnProcess,
} from '../src/platform/processes.ts';
