// `node scripts/mutant-coverage.ts <tree> <coverage-dir> <file>:<line>...`: prints, for each
// mutated line, the test files of the wide list whose child process ran it in the baseline,
// read from the V8 coverage files NODE_V8_COVERAGE wrote (#597, ADR 0303).

export interface MainResult {
  exitCode: number;
  stdout: string[];
  stderr: string[];
}

export const main = async (_argv: readonly string[]): Promise<MainResult> => {
  throw new Error('not implemented');
};

if (import.meta.main) {
  const { exitCode, stdout, stderr } = await main(process.argv.slice(2));
  for (const line of stdout) console.log(line);
  for (const line of stderr) console.error(line);
  process.exitCode = exitCode;
}
