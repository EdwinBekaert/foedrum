// npm run demo (ADR 0097, ADR 0139): a scratch Brewery and target repository in .foedrum/tmp/demo,
// an order on an in-process fake code host, brewed with the demo Brewery's own recipe (Nip's steps,
// tasted through three lenses side by side, ADR 0185) by the Nip fixture's scripted Gauger,
// Cellarman and Finer and three Tasters through `foedrum serve`'s own Cellar
// (scripts/demo/cellar.ts), which is killed
// mid-attempt and started again, until the batch is on tap with one pull request and one status
// comment; then a second order brewed by `foedrum brew` instead of the Cellar, and `foedrum
// resume`'s line for the Cellarman's attempt. No gh, no GitHub, no claude, no network.
// It walks through it in steps (scripts/demo/walkthrough.ts), each with what to look for, and
// waits for Enter between them on a terminal; `--no-pause` goes straight through. `--in <folder>`
// runs it in another folder inside .foedrum/tmp, as the integration test does.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { cliFromCheckout } from '../src/cli/cli-main.ts';
import { execProcess } from '../src/platform/processes.ts';
import { removeTree } from '../src/platform/remove.ts';
import { runGit } from '../src/workspace/git.ts';
import { NIP_TARGET_FILES } from '../test/helpers/nip-fixture.ts';
import { DEMO_GIT_CONFIG } from './demo/brewer.ts';
import { codeHost, fileJournal } from './demo/code-host.ts';
import {
  BREW_ORDER,
  BREWERY,
  breweryFiles,
  CRASH_LINE,
  DIAGNOSIS,
  gitConfig,
  gitEnvOf,
  type Life,
  localConfig,
  ORDER,
  problemsOf,
  scratchFolder,
  TARGET,
  USER,
} from './demo/core.ts';
import {
  BATCH,
  commentMarkdown,
  diagnosisLines,
  LOST_LINE,
  PAUSE_PROMPT,
  pausesBetweenSteps,
  RESUMED,
  replayLines,
  STATUS_LINE,
  splitOutput,
  stepLines,
} from './demo/walkthrough.ts';

/** How long one life of the Cellar may take: the recipe's attempts need well under a minute. */
const LIFE_MS = 600_000;

const root = resolve(import.meta.dirname, '..');
const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const indented = (lines: readonly string[]): void => {
  for (const line of lines) say(line === '' ? '' : `  ${line}`);
};

const { values } = parseArgs({
  options: { in: { type: 'string' }, 'no-pause': { type: 'boolean' } },
});
let scratch: string;
try {
  scratch = scratchFolder(root, values.in, process.cwd());
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(2);
}

// Every git of the demo, its own, the Cellar's and the CLI's, reads only the demo's configuration:
// the machine's global and system ones (an identity, signing, url rewrites, hooks) take no part.
const ownGit = gitEnvOf(scratch);
Object.assign(process.env, ownGit);

const git = async (cwd: string, args: string[]): Promise<void> => {
  const result = await runGit(cwd, args, { config: DEMO_GIT_CONFIG, env: ownGit });
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

const noPause = values['no-pause'] === true;
const interactive = process.stdin.isTTY === true;
let inputEnded = false;
/** Waits for Enter; Ctrl+C ends the demo, and the end of input (Ctrl+D) ends the pauses. */
const pause = async (): Promise<void> => {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  prompt.on('SIGINT', () => process.exit(130));
  let answered = false;
  await new Promise<void>((done) => {
    prompt.once('close', done);
    prompt.question(PAUSE_PROMPT, () => {
      answered = true;
      done();
    });
  });
  prompt.close();
  if (!answered) inputEnded = true;
};
let step = 0;
/** Opens the next step, after a pause when there was one before it. */
const next = async (): Promise<void> => {
  if (step > 0 && pausesBetweenSteps({ noPause, interactive, inputEnded })) await pause();
  for (const line of stepLines(step)) say(line);
  step += 1;
};

/** The foedrum commands the walkthrough ran, and how each ended. */
const commands: { argv: string[]; exitCode: number; stderr: string }[] = [];
/**
 * `foedrum <argv>` as the CLI runs it in the Brewery: status and replay read only its store. Its
 * output is shown as the lines `shown` makes of it.
 */
const foedrum = async (
  brewery: string,
  argv: string[],
  shown = (output: string): string[] => output.trimEnd().split('\n'),
): Promise<void> => {
  const { exitCode, stdout, stderr } = await cliFromCheckout(argv, brewery);
  commands.push({ argv, exitCode, stderr });
  say(`$ foedrum ${argv.join(' ')}`);
  indented(shown(`${stdout}${stderr}`));
};

say(`demo: a scratch Brewery ${BREWERY} and its target ${TARGET} in ${scratch}`);
// The last run's folder goes first: the demo always starts from nothing.
await removeTree(scratch);
mkdirSync(scratch, { recursive: true });
write(ownGit.GIT_CONFIG_GLOBAL, gitConfig(join(scratch, 'web.git')));
const web = await repository('web', NIP_TARGET_FILES);
const brewery = await repository('brewery', breweryFiles());
write(join(brewery, '.foedrum', 'local.jsonc'), localConfig(join(scratch, 'work'), web));

const cellar = join(root, 'scripts', 'demo', 'cellar.ts');
const live = (life: Life) =>
  execProcess(process.execPath, [cellar, scratch, life], {
    cwd: root,
    env: process.env,
    timeoutMs: LIFE_MS,
  });

await next();
say('demo: what foedrum doctor would tell serve, given by the demo instead:');
for (const line of diagnosisLines(DIAGNOSIS)) say(line);

await next();
say(
  `demo: issue #${ORDER.number} of ${BREWERY} by ${ORDER.author}, labelled ${ORDER.labels.join(', ')}, on the fake code host:`,
);
indented([`"${ORDER.title}"`, ORDER.body]);

await next();
say('demo: the Cellar starts and brews, and is killed mid-attempt');
const crash = await live('crash');
const [brewing, killed] = splitOutput(crash.output, (line) => line === CRASH_LINE, 'before');
indented(brewing);

await next();
indented(killed);
say('demo: the Cellar starts again on the same Brewery');
const restart = await live('finish');
const [found, after] = splitOutput(restart.output, (line) => line.startsWith(LOST_LINE), 'with');
indented(found);

await next();
// Up to the status that first shows the batch on tap, which goes with the pull request.
const onTap = after.findIndex((line) => / on tap /.test(line));
const cut = onTap < 0 ? after.length : Math.max(0, after.lastIndexOf(STATUS_LINE, onTap));
indented(after.slice(0, cut));

await next();
indented(after.slice(cut));
const journal = fileJournal(join(scratch, 'code-host.jsonl'));
let host = await codeHost(journal);
const comments = host.comments(BREWERY, ORDER.number);
for (const pull of host.pulls()) {
  say(
    `demo: pull request #${pull.number} on ${pull.repo}: "${pull.title}", ${pull.head} into ${pull.base}`,
  );
  say(
    `demo: it is #${pull.number}: the fake code host numbers comments and pull requests from one counter, and the status comment came first (GitHub numbers each repository's issues and pull requests together, and comments apart)`,
  );
}
for (const comment of comments) {
  say(
    `demo: status comment by ${comment.author} on ${BREWERY}#${ORDER.number}, its Markdown without the hidden revision marker:`,
  );
  indented(commentMarkdown(comment.body).split('\n'));
}

await next();
await foedrum(brewery, ['status']);

await next();
// What each lens found, how its findings ended and what it cost (ADR 0221).
await foedrum(brewery, ['lenses']);

await next();
// The label of the Cellar's order, so the second order is routed to the same recipe.
const { labels } = ORDER;
say(
  `demo: ${USER} labels issue #${BREW_ORDER.number} ${labels.join(', ')}, now the Cellar has stopped`,
);
await host.fetch(`https://api.github.com/repos/${BREWERY}/issues/${BREW_ORDER.number}/labels`, {
  method: 'POST',
  body: JSON.stringify({ labels }),
});
say(`$ foedrum brew ${BREW_ORDER.number} --as ${USER}`);
const brew = await live('brew');
indented(brew.output.trimEnd().split(/\r?\n/));

await next();
// As a Claude Code session runs it (ADR 0126): resume names the attempt and prints the line to
// run in a terminal, instead of opening claude, which the demo never starts.
const childSession = process.env.CLAUDE_CODE_CHILD_SESSION;
process.env.CLAUDE_CODE_CHILD_SESSION = '1';
try {
  await foedrum(brewery, ['resume', BATCH, RESUMED]);
} finally {
  if (childSession === undefined) delete process.env.CLAUDE_CODE_CHILD_SESSION;
  else process.env.CLAUDE_CODE_CHILD_SESSION = childSession;
}

await next();
// The state under the events, which it only counts (#662).
await foedrum(brewery, ['replay', BATCH], (output) => replayLines(output, BATCH));

say('');
host = await codeHost(journal);
const problems = problemsOf({
  crash,
  restart,
  brew,
  pulls: host.pulls(),
  comments: new Map(
    [ORDER, BREW_ORDER].map(({ number }) => [number, host.comments(BREWERY, number)]),
  ),
  commands,
});
if (problems.length > 0) {
  for (const problem of problems) say(`demo: ${problem}`);
  process.exitCode = 1;
} else {
  say(
    'demo: both orders on tap, one through a crash and a restart, each with one pull request and one status comment',
  );
}
