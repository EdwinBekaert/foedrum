// A throwaway Brewery's files for `foedrum serve`'s tests (ADR 0063): one target repository, a
// one-step recipe whose brewer reads the order, and the inputs `serveSetup` reads them from.

import { resolve } from 'node:path';
import { diagnose } from '../../src/cli/doctor.ts';
import type { ServeInputs } from '../../src/cli/serve-config.ts';
import { linux } from './doctor-facts.ts';

export const root = resolve('brewery');
export const home = resolve('home', 'ann');
export const clone = resolve('src', 'web');

export const config = (fields: Record<string, unknown> = {}, web: Record<string, unknown> = {}) =>
  JSON.stringify({
    brewery: 'Acme/Brewery',
    repositories: {
      'acme/web': {
        checks: { build: null, typecheck: null, lint: null, format: null, test: 'npm test' },
        tools: ['Bash(npm test*)'],
        ...web,
      },
    },
    ...fields,
  });
export const local = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({ clones: { 'acme/web': clone }, ...fields });
export const models = (alias = 'quick') =>
  JSON.stringify({ models: { [alias]: 'claude-haiku-5-5' } });

export const recipe = JSON.stringify({
  name: 'stout',
  description: 'Brews an order in one step.',
  steps: [{ id: 'brew', brewer: 'cellarman' }],
  testFirst: false,
});
export const brewer = `---
{
  "name": "cellarman",
  "description": "Brews the order.",
  "version": 1,
  "inputs": [{ "name": "order", "from": "order" }],
  "output": { "doc": "brew.md", "schema": "outDoc" },
  "produces": "commits",
  "model": "quick",
  "effort": "low",
  "tools": { "allow": ["Read", "Write"] },
  "access": "write",
  "tree": "task",
  "git": { "commit": true },
  "deadline": "10m",
  "maxAttempts": 1
}
---
Brew the order in {order}.
`;

export const serveInputs = (overrides: Partial<ServeInputs> = {}): ServeInputs => ({
  root,
  home,
  platform: 'linux',
  env: { PATH: '/usr/bin', HOME: home, GH_TOKEN: 'ghp_serve', AWS_SECRET_ACCESS_KEY: 'aws' },
  files: {
    config: config(),
    local: local(),
    models: models(),
    brewery: {
      recipes: [{ path: 'recipes/stout.jsonc', text: recipe }],
      brewers: [{ path: 'brewers/cellarman.md', text: brewer }],
    },
  },
  diagnosis: diagnose(linux()),
  ...overrides,
});
