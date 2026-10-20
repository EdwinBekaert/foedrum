// npm run demo (ADR 0097): a scratch Brewery and target repository in .foedrum/tmp/demo, one order
// on an in-process fake code host, brewed by a scripted brewer through `foedrum serve`'s own
// Cellar (scripts/demo/cellar.ts), which is killed mid-attempt and started again, until the batch
// is on tap with one pull request and one status comment. No gh, no GitHub, no claude, no network.
// `--in <folder>` runs it in another folder inside .foedrum/tmp, as the integration test does.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { removeTree } from '../src/platform/remove.ts';
import { runGit } from '../src/workspace/git.ts';
import { DEMO_GIT_CONFIG } from './demo/brewer.ts';
import { codeHost, fileJournal } from './demo/code-host.ts';
import {
  BREWERY,
  breweryFiles,
  type Life,
  localConfig,
  ORDER,
  problemsOf,
  scratchFolder,
  TARGET,
} from './demo/core.ts';
import { spawnProcess } from './process-runner.ts';

/** How long one life of the Cellar may take; it needs a few seconds. */
const LIFE_MS = 120_000;

const root = resolve(import.meta.dirname, '..');
const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const { values } = parseArgs({ options: { in: { type: 'string' } } });
let scratch: string;
try {
  scratch = scratchFolder(root, values.in, process.cwd());
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(2);
}

const git = async (cwd: string, args: string[]): Promise<void> => {
  const result = await runGit(cwd, args, { config: DEMO_GIT_CONFIG });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim()}`);
  }
};
const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** A bare remote at `<name>.git` and a clone of it at `<name>` with `files` on main. */
const repository = async (name: string, files: Record<string, string>): Promise<string> => {
  const clone = join(scratch, name);
  await git(scratch, ['init', '-q', '--bare', '--initial-branch=main', `${name}.git`]);
  await git(scratch, ['clone', '-q', `${name}.git`, name]);
  for (const [path, text] of Object.entries(files)) write(join(clone, path), text);
  await git(clone, ['add', '--all']);
  await git(clone, ['commit', '-q', '-m', `Start ${name}`]);
  await git(clone, ['push', '-q', 'origin', 'main']);
  return clone;
};

say(`demo: a scratch Brewery ${BREWERY} and its target ${TARGET} in ${scratch}`);
// The last run's folder goes first: the demo always starts from nothing.
await removeTree(scratch);
mkdirSync(scratch, { recursive: true });
const web = await repository('web', { 'README.md': '# web\n' });
const brewery = await repository('brewery', breweryFiles());
write(join(brewery, '.foedrum', 'local.jsonc'), localConfig(join(scratch, 'work'), web));
say(
  `demo: the order is issue #${ORDER.number} of ${BREWERY}, "${ORDER.title}", on the fake code host`,
);

const cellar = join(root, 'scripts', 'demo', 'cellar.ts');
const live = async (life: Life, what: string) => {
  say(`demo: ${what}`);
  const outcome = await spawnProcess(process.execPath, [cellar, scratch, life], root, {
    timeoutMs: LIFE_MS,
  });
  for (const line of outcome.output.trimEnd().split(/\r?\n/)) say(`  ${line}`);
  return outcome;
};
const crash = await live('crash', 'the Cellar starts and brews, and is killed mid-attempt');
const restart = await live('finish', 'the Cellar starts again on the same Brewery');

const host = await codeHost(fileJournal(join(scratch, 'code-host.jsonl')));
const pulls = host.pulls();
const comments = host.comments(BREWERY, ORDER.number);
for (const pull of pulls) {
  say(
    `demo: pull request #${pull.number} on ${pull.repo}: "${pull.title}", ${pull.head} into ${pull.base}`,
  );
}
for (const comment of comments) {
  say(`demo: status comment by ${comment.author} on ${BREWERY}#${ORDER.number}:`);
  for (const line of comment.body.trimEnd().split('\n')) say(`  ${line}`);
}
const problems = problemsOf({ crash, restart, pulls, comments });
if (problems.length > 0) {
  for (const problem of problems) say(`demo: ${problem}`);
  process.exitCode = 1;
} else {
  say('demo: on tap after a crash and a restart, with one pull request and one status comment');
}
