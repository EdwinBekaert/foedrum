// `foedrum doctor`'s facts from a checkout (doctor-main.ts), the wiring main.ts runs, with a fake
// process runner and a fake PATH: the checkout's foedrum.jsonc and recipe files are read, and gh is
// asked about the host foedrum.jsonc names through the runner it is given (ADR 0021, ADR 0073).

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { doctorFromCheckout } from '../../src/cli/doctor-main.ts';
import { storePath } from '../../src/cli/serve-config.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { ExecProcess } from '../../src/platform/processes.ts';
import { makeTempDir } from '../helpers/temp-dir.ts';

const fakeRunner = () => {
  const calls: { file: string; args: readonly string[] }[] = [];
  const exec: ExecProcess = async (file, args) => {
    calls.push({ file, args });
    const output = args[0] === 'auth' ? 'ghe.example\n  ✓ Logged in to ghe.example\n' : '1.0.0\n';
    return { exitCode: 0, stdout: output, stderr: '', output };
  };
  return { exec, calls };
};

describe('doctorFromCheckout', () => {
  const dir = makeTempDir('doctor-main');
  after(() => dir.remove());
  const config = '{ "repositories": {}, "githubApi": "https://ghe.example/api/v3" }';
  writeFileSync(join(dir.path, 'foedrum.jsonc'), config);
  mkdirSync(join(dir.path, 'recipes'));
  writeFileSync(join(dir.path, 'recipes', 'pale.jsonc'), '{}');

  it("reads the checkout's files, and asks gh about their host through the runner it is given", async () => {
    const { exec, calls } = fakeRunner();
    const facts = await doctorFromCheckout(dir.path, {
      exec,
      resolve: (name) => `/usr/bin/${name}`,
      // Never the user's own list (ADR 0114).
      denylist: () => ({ kind: 'none', path: '/made-up/denylist.txt' }),
    });
    assert.equal(facts.config, config);
    assert.deepEqual(
      facts.brewery?.recipes.map(({ path }) => path),
      ['recipes/pale.jsonc'],
    );
    assert.equal(facts.github?.host, 'ghe.example');
    assert.ok(
      calls.some(
        ({ file, args }) =>
          file === '/usr/bin/gh' && args.join(' ') === 'auth status --hostname ghe.example',
      ),
    );
  });

  it('reads ANTHROPIC_BASE_URL from the environment it is given, not its own (ADR 0063, ADR 0087)', async () => {
    const { exec } = fakeRunner();
    const facts = await doctorFromCheckout(dir.path, {
      exec,
      resolve: (name) => `/usr/bin/${name}`,
      denylist: () => ({ kind: 'none', path: '/made-up/denylist.txt' }),
      env: { PATH: '/usr/bin', ANTHROPIC_BASE_URL: 'https://given.example.com/v1' },
    });
    assert.equal(facts.modelBaseUrl, 'https://given.example.com/v1');
  });

  it('reads the system map in each clone through the runner it is given (ADR 0317)', async () => {
    const brewery = makeTempDir('doctor-main-map');
    try {
      const clone = join(brewery.path, 'lib-clone');
      mkdirSync(clone);
      const checks = { build: null, typecheck: null, lint: null, format: null, test: null };
      writeFileSync(
        join(brewery.path, 'foedrum.jsonc'),
        JSON.stringify({ brewery: 'acme/brewery', repositories: { 'acme/lib': { checks } } }),
      );
      mkdirSync(join(brewery.path, '.foedrum'));
      writeFileSync(
        join(brewery.path, '.foedrum', 'local.jsonc'),
        JSON.stringify({ clones: { 'acme/lib': clone } }),
      );
      const tip = 'f'.repeat(40);
      const exec: ExecProcess = async (file, args, options) => {
        const answer = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', output: stdout });
        if (file !== 'git' || options?.cwd !== clone) return answer('1.0.0\n');
        if (args[0] === 'rev-parse') return answer(`${tip}\n`);
        if (args[0] === 'ls-tree')
          return answer(args.includes('--name-only') ? 'package.json\0' : '');
        return answer(JSON.stringify({ name: '@acme/lib' }));
      };
      const facts = await doctorFromCheckout(brewery.path, {
        exec,
        resolve: (name) => `/usr/bin/${name}`,
        denylist: () => ({ kind: 'none', path: '/made-up/denylist.txt' }),
      });
      assert.deepEqual(facts.systemMap, [
        {
          repo: 'acme/lib',
          base: 'origin/main',
          read: {
            commit: tip,
            entry: {
              manifests: [{ path: 'package.json', ecosystem: 'npm' }],
              publishes: [{ name: '@acme/lib', ecosystem: 'npm' }],
              dependsOn: [],
              modules: [],
              unreadable: [],
            },
          },
        },
      ]);
    } finally {
      brewery.remove();
    }
  });
});

describe('doctorFromCheckout: the models brewer attempts reported (ADR 0419)', () => {
  const options = {
    exec: fakeRunner().exec,
    resolve: (name: string) => `/usr/bin/${name}`,
    denylist: () => ({ kind: 'none' as const, path: '/made-up/denylist.txt' }),
  };

  it("reads them from the Brewery's event log", async () => {
    const brewery = makeTempDir('doctor-main-tasting');
    try {
      mkdirSync(join(brewery.path, '.foedrum'));
      const store = openSqliteEventStore(storePath(brewery.path));
      const ref = { batchId: 'b1', stepId: 'brew', attempt: 1 };
      try {
        store.withTransaction((tx) => {
          tx.append({
            type: 'batch.ordered',
            batchId: 'b1',
            order: { issue: 1 },
            routeBy: '2026-12-31T00:00:00.000Z',
          });
          tx.append({
            type: 'batch.recipe_chosen',
            batchId: 'b1',
            recipe: 'nip',
            reason: 'label',
            source: 'label',
          });
          tx.append({ type: 'step.scheduled', ...ref, deadlineAt: '2026-11-29T12:00:00.000Z' });
          tx.append({ type: 'step.started', ...ref });
          tx.append({
            type: 'step.finished',
            ...ref,
            outcome: { kind: 'succeeded', output: null },
            claude: { version: '2.1.301', model: 'claude-opus-5-6' },
          });
        });
      } finally {
        // Closed before the folder goes: Windows cannot delete an open file.
        store.close();
      }
      const facts = await doctorFromCheckout(brewery.path, options);
      assert.deepEqual(facts.tasting?.used, [
        {
          recipe: 'nip',
          stepId: 'brew',
          model: 'claude-opus-5-6',
          deadlineAt: new Date('2026-11-29T12:00:00.000Z'),
        },
      ]);
    } finally {
      brewery.remove();
    }
  });

  it('reads none, and makes no event log, where the Brewery has none yet', async () => {
    const brewery = makeTempDir('doctor-main-no-store');
    try {
      const facts = await doctorFromCheckout(brewery.path, options);
      assert.deepEqual(facts.tasting?.used, []);
      assert.equal(existsSync(storePath(brewery.path)), false);
    } finally {
      brewery.remove();
    }
  });
});
