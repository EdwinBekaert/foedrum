// Real git for the brew-review scratch tree (issue #80): a `<scratch>/tree` folder that is not a
// repository, left by an interrupted clone or a partial removal, inside a checkout. A git command
// aimed at it walks up to the checkout and changes that HEAD, unless GIT_CEILING_DIRECTORIES
// stops the search at the scratch folder.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { removeTree } from '../../src/platform/remove.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

describe('a git command aimed at a scratch tree that is not a repository', () => {
  let dir: TempDir;
  let checkout: string;
  let scratch: string;
  let tree: string;

  // The environment without git's own variables, plus the given ceilings. git never searches
  // above the test folder, so even a failed setup cannot reach the checkout these tests run in.
  const gitEnv = (...ceilings: string[]): NodeJS.ProcessEnv => ({
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
    GIT_CEILING_DIRECTORIES: [dir.path, ...ceilings].join(delimiter),
  });

  const git = (cwd: string, args: string[], env = gitEnv()) =>
    spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
      cwd,
      env,
      encoding: 'utf8',
    });

  // Runs a setup step and fails the test when git does.
  const setUp = (cwd: string, args: string[]): void => {
    const { status, stderr } = git(cwd, args);
    assert.equal(status, 0, stderr);
  };

  // The branch the checkout's HEAD points at, or undefined when it is detached.
  const branch = (): string | undefined => {
    const { status, stdout } = git(checkout, ['symbolic-ref', '-q', 'HEAD']);
    return status === 0 ? stdout.trim() : undefined;
  };

  beforeEach(() => {
    dir = makeTempDir('scratch-ceiling');
    checkout = join(dir.path, 'checkout');
    setUp(dir.path, ['init', '-q', '-b', 'main', checkout]);
    setUp(checkout, ['commit', '-q', '--allow-empty', '-m', 'Initial commit']);
    scratch = join(checkout, '.foedrum', 'tmp', '80', 'scratch');
    tree = join(scratch, 'tree');
    mkdirSync(tree, { recursive: true });
  });
  afterEach(() => removeTree(dir.path));

  it('detaches the HEAD of the checkout around it, with -C or as the working directory', () => {
    assert.equal(branch(), 'refs/heads/main');
    const viaOption = git(checkout, ['-C', tree, 'checkout', '--detach', 'HEAD']);
    assert.equal(viaOption.status, 0, viaOption.stderr);
    assert.equal(branch(), undefined);

    setUp(checkout, ['switch', '-q', 'main']);
    assert.equal(branch(), 'refs/heads/main');
    const viaCwd = git(tree, ['checkout', '--detach', 'HEAD']);
    assert.equal(viaCwd.status, 0, viaCwd.stderr);
    assert.equal(branch(), undefined);
  });

  it('fails and leaves the checkout alone with GIT_CEILING_DIRECTORIES set to the scratch folder', () => {
    const env = gitEnv(scratch);
    const result = git(checkout, ['-C', tree, 'checkout', '--detach', 'HEAD'], env);
    assert.equal(result.status, 128);
    assert.match(result.stderr, /not a git repository/);
    assert.equal(branch(), 'refs/heads/main');
  });

  it('still reaches the checkout when GIT_CEILING_DIRECTORIES is relative, which git ignores', () => {
    const env = gitEnv(join('.foedrum', 'tmp', '80', 'scratch'));
    const result = git(checkout, ['-C', tree, 'checkout', '--detach', 'HEAD'], env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(branch(), undefined);
  });
});
