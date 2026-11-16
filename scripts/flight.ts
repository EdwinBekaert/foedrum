// node scripts/flight.ts --recipe <name> [--brewer <name> --model <level or id> --effort <effort>]
// [--runs <n>] [--dry-run] (#1083, ADR 0409): a Flight. It brews every order of the tasting room
// (ADR 0404) 3 times with a default recipe as it ships, or with one brewer's steps on the model and
// effort given, the whole batch on the real claude with no step scripted, on the fake code host
// through the comparison's harness (scripts/tasting-compare/harness.ts). Each run's target is its
// order's starting tree and its issue the order's order.md. After each batch, it lays the order's
// hidden tests over a scratch clone of the head a person gets and runs them with `node --test`, and
// records whether they passed, the changed files outside the order's allowed paths, and each step's
// tokens, turns and time, one record per run in results.jsonl under
// .foedrum/tmp/flight/<recipe>[-<brewer>-<model>-<effort>]; a stopped Flight goes on where it
// stopped. A run on a model it did not ask for stops it. --dry-run scripts every brewer, in a
// dry-run folder of its own, to show a Flight end to end before any token is spent; it skips the
// recipe's test-first steps, which a real Flight runs. By hand only:
// it needs claude's login, which no test layer reaches (ADR 0057). Its decisions are
// scripts/flight/core.ts.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { resolveExecutable } from '../src/platform/executables.ts';
import { execProcess } from '../src/platform/processes.ts';
import { BREWERY, TARGET, USER } from './demo/core.ts';
import {
  askedModels,
  dryRunScript,
  FLIGHT_OPTIONS,
  type FlightRecord,
  flightBreweryFiles,
  flightFolderOf,
  flightOptionsOf,
  flightRecordOf,
  flightStop,
  flightTable,
  hiddenOf,
  nextFlightRun,
  outsidePaths,
} from './flight/core.ts';
import { ORDERS, startingTree, tastingRoomOrders, withLayer } from './flight-orders.ts';
import { compare, type Mode, transcriptOf, write } from './tasting-compare/harness.ts';
import { scriptedTranscript } from './tasting-compare/real.ts';

const root = resolve(import.meta.dirname, '..');

/** A default recipe's text by its name, undefined when there is none. */
const recipeText = (name: string): string | undefined => {
  if (!/^[a-z0-9-]+$/.test(name)) return undefined;
  const file = join(root, 'defaults', 'recipes', `${name}.jsonc`);
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
};

const chosen = flightOptionsOf(parseArgs({ options: FLIGHT_OPTIONS }).values, recipeText);
if (chosen.kind === 'refused') {
  process.stderr.write(`${chosen.message}\n`);
  process.exit(2);
}
const { kind: _, ...settings } = chosen;
const { runs, dryRun } = settings;
const text = recipeText(settings.recipe) ?? '';
const claude = dryRun ? 'the scripted brewers, never started' : resolveExecutable('claude');
if (claude === undefined) {
  process.stderr.write('claude is not on the PATH: a Flight brews with the real claude\n');
  process.exit(1);
}
const asked = askedModels(settings, text);
const orders = new Map(tastingRoomOrders().map((order) => [order.name, order]));
const orderOf = (name: string) => {
  const order = orders.get(name);
  if (order === undefined) throw new Error(`no order ${name} in the tasting room`);
  return order;
};

/** The most of the hidden tests' output a record keeps: its end, where node --test sums up. */
const OUTPUT_KEPT = 4096;

const mode: Mode<string, FlightRecord> = {
  folders: ['flight'],
  setups: [...orders.keys()],
  order: (name) => join(ORDERS, name, 'order.md'),
  recipeOf: () => settings.recipe,
  breweryFiles: () =>
    flightBreweryFiles(settings, text, { brewery: BREWERY, target: TARGET, user: USER }),
  target: async (name, scratch, git) => {
    // Only the starting tree: a brewer sees the base and order.md, never the hidden tests (ADR 0404).
    await git(scratch, ['init', '-q', '--bare', '--initial-branch=main', 'web.git']);
    await git(scratch, ['clone', '-q', 'web.git', 'web']);
    const web = join(scratch, 'web');
    for (const [path, body] of Object.entries(startingTree(orderOf(name)))) {
      write(join(web, ...path.split('/')), body);
    }
    await git(web, ['add', '--all']);
    await git(web, ['commit', '-q', '-m', `Start ${name}`]);
    await git(web, ['push', '-q', 'origin', 'main']);
  },
  script: async (name) => (dryRun ? dryRunScript(orderOf(name), text) : {}),
  // No step is scripted on a real Flight.
  scriptedStep: '',
  next: (records, runCount) => nextFlightRun(records, runCount, [...orders.keys()]),
  recordOf: async (events, name, planned, { scratch, git }) => {
    const record = flightRecordOf(events, settings, asked, (id, worktree) =>
      dryRun ? scriptedTranscript(worktree, planned.get(id) ?? 'no plan') : transcriptOf(id),
    );
    const { head } = record.flight;
    if (head === undefined) return record;
    const order = orderOf(name);
    // The head as a person gets it, from the scratch remote, or the Cellar's clone for a head that
    // reached no pull request; the hidden tests laid over it last.
    const hidden = join(scratch, 'hidden');
    await git(scratch, ['clone', '-q', 'web.git', 'hidden']);
    const greenTree = events.findLast(
      ({ event }) => event.type === 'step.started' && event.worktree?.commit === head,
    )?.event;
    if (record.flight.headFrom === 'green' && greenTree?.type === 'step.started') {
      await git(hidden, ['fetch', '-q', greenTree.worktree?.path ?? '', head]);
    }
    await git(hidden, ['checkout', '-q', head]);
    const changed = (
      await git(hidden, ['diff', '--name-only', '--no-renames', 'origin/main', head])
    )
      .split(/\r?\n/)
      .filter((path) => path !== '');
    const tests = withLayer({}, order.hidden);
    for (const [path, body] of Object.entries(tests)) write(join(hidden, ...path.split('/')), body);
    // Without NODE_TEST_CONTEXT, which would make the hidden run report to a test runner above it.
    const { NODE_TEST_CONTEXT: __, ...env } = process.env;
    const ran = await execProcess(process.execPath, ['--test', ...Object.keys(tests).sort()], {
      cwd: hidden,
      env,
      timeoutMs: 120_000,
    });
    return {
      ...record,
      flight: {
        ...record.flight,
        hidden: hiddenOf(ran.exitCode),
        hiddenOutput: ran.output.slice(-OUTPUT_KEPT),
        changed,
        outside: outsidePaths(changed, order.allowedPaths),
      },
    };
  },
  table: flightTable,
  stop: (record) => flightStop(record, asked),
};

if (dryRun) {
  process.stdout.write(
    `flight: a dry run skips ${settings.recipe}'s test-first steps, which a real Flight runs\n`,
  );
}
await compare(mode, {
  folder: join(
    root,
    '.foedrum',
    'tmp',
    'flight',
    flightFolderOf(settings),
    ...(dryRun ? ['dry-run'] : []),
  ),
  runs,
  dryRun,
  claude,
});
