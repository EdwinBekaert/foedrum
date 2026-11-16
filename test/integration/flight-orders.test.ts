// The Flight's proof (ADR 0404): for every order in tasting-room/, its hidden tests fail on
// the starting repository and pass with its reference solution, each run by a real `node --test`.

import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import {
  type FlightOrder,
  folderFiles,
  type ProofRun,
  proofProblem,
  proofRuns,
  readOrder,
  TRAP_KINDS,
} from '../../scripts/flight-orders.ts';
import { execProcess } from '../../src/platform/processes.ts';
import { makeTempDir } from '../helpers/temp-dir.ts';

const ROOM = join(import.meta.dirname, '..', '..', 'tasting-room');

const orders: FlightOrder[] = readdirSync(ROOM, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => readOrder(entry.name, folderFiles(join(ROOM, entry.name))));

/** Lays `run`'s tree down in a folder of its own and runs its hidden tests there. */
const proved = async (run: ProofRun): Promise<{ exitCode: number | null; output: string }> => {
  const dir = makeTempDir('flight-proof');
  try {
    for (const [path, text] of Object.entries(run.tree)) {
      const file = join(dir.path, ...path.split('/'));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    // Without NODE_TEST_CONTEXT, which would make the child report to this runner as a nested run.
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;
    const result = await execProcess(process.execPath, ['--test', ...run.tests], {
      cwd: dir.path,
      env,
      timeoutMs: 120_000,
    });
    return { exitCode: result.exitCode, output: result.output };
  } finally {
    dir.remove();
  }
};

test('the tasting room holds an order of every kind of trap', () => {
  const kinds = new Set(orders.map((order) => order.trap.kind));
  assert.deepEqual(
    TRAP_KINDS.filter((kind) => !kinds.has(kind)),
    [],
  );
});

for (const order of orders) {
  describe(order.name, () => {
    for (const run of proofRuns(order)) {
      const name =
        run.expect === 'fail'
          ? 'its hidden tests fail on the starting repository'
          : 'its hidden tests pass with the reference solution';
      test(name, async () => {
        const { exitCode, output } = await proved(run);
        assert.equal(proofProblem(run, exitCode), undefined, output);
      });
    }
  });
}
