// `node scripts/with-checkout-tmp.ts <node arguments…>`: runs this node with the arguments and
// with the system temp directory moved into the checkout, then removes it (issue #70).
// npm test runs through it: node --test --experimental-test-coverage writes its coverage files
// to mkdtempSync(join(os.tmpdir(), 'node-coverage-')), and NODE_V8_COVERAGE does not move them
// (the runner only copies them there afterwards; lib/internal/test_runner/coverage.js). os.tmpdir()
// reads TEMP and TMP on Windows and TMPDIR, TMP and TEMP elsewhere, so setting all three keeps
// those files, and anything a test or the code under test puts in os.tmpdir(), in .foedrum/tmp/.

export interface WithCheckoutTmpOptions {
  args: string[];
  env: NodeJS.ProcessEnv;
  execPath: string;
  // Creates a fresh folder for this run and returns its path.
  makeTempDir: () => string;
  removeDir: (path: string) => Promise<void>;
  // Runs a program with its output on this terminal; resolves to its exit code, null when it
  // could not start or was killed.
  run: (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<number | null>;
  write: (text: string) => void;
}

const USAGE = 'usage: node scripts/with-checkout-tmp.ts <node arguments…>\n';

// Resolves to the exit code.
export const withCheckoutTmp = async ({
  args,
  env,
  execPath,
  makeTempDir,
  removeDir,
  run,
  write,
}: WithCheckoutTmpOptions): Promise<number> => {
  if (args.length === 0) {
    write(USAGE);
    return 2;
  }
  const dir = makeTempDir();
  let exitCode: number;
  try {
    exitCode = (await run(execPath, args, { ...env, TEMP: dir, TMP: dir, TMPDIR: dir })) ?? 1;
  } finally {
    // Also when run throws; that error is the one that matters, so a failed removal is reported
    // but does not replace it.
    await removeDir(dir).catch((error: unknown) => {
      write(`could not remove ${dir}: ${error instanceof Error ? error.message : String(error)}\n`);
      exitCode ||= 1;
    });
  }
  return exitCode;
};

if (import.meta.main) {
  const { spawn } = await import('node:child_process');
  const { mkdirSync, mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { removeTree } = await import('../src/platform/remove.ts');
  const base = join(import.meta.dirname, '..', '.foedrum', 'tmp', 'tests');
  // Ctrl+C reaches the program too; wait for it to stop, so the folder is still removed.
  process.on('SIGINT', () => {});
  process.exitCode = await withCheckoutTmp({
    args: process.argv.slice(2),
    env: process.env,
    execPath: process.execPath,
    makeTempDir: () => {
      mkdirSync(base, { recursive: true });
      return mkdtempSync(join(base, 'tmpdir-'));
    },
    removeDir: removeTree,
    run: (file, args, env) =>
      new Promise((resolve, reject) => {
        const child = spawn(file, args, { env, stdio: 'inherit' });
        child.on('error', reject);
        child.on('close', resolve);
      }),
    write: (text) => process.stderr.write(text),
  });
}
