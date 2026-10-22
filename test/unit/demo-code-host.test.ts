import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { codeHost, fileJournal, type Journal } from '../../scripts/demo/code-host.ts';
import { BREW_ORDER, BREWERY, LOGIN, ORDER, TARGET } from '../../scripts/demo/core.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const api = 'https://api.github.com';

const memoryJournal = (): Journal & { kept: string[] } => {
  const kept: string[] = [];
  return { kept, lines: () => [...kept], append: (line) => kept.push(line) };
};

const send = (host: { fetch: typeof fetch }, method: string, path: string, body?: unknown) =>
  host.fetch(`${api}${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('the demo code host', () => {
  it('lists the order on the Brewery repository, opened by the user, and answers the login', async () => {
    const host = await codeHost(memoryJournal());
    const listed = (await (
      await send(host, 'GET', `/repos/${BREWERY}/issues?labels=${ORDER.labels.join(',')}`)
    ).json()) as { number: number; title: string; user: { login: string } }[];
    assert.deepStrictEqual(
      listed.map(({ number, title, user }) => ({ number, title, author: user.login })),
      [{ number: ORDER.number, title: ORDER.title, author: ORDER.author }],
    );
    const user = (await (await send(host, 'GET', '/user')).json()) as { login: string };
    assert.equal(user.login, LOGIN);
  });

  it('answers gh as the tests fake gh does', async () => {
    const host = await codeHost(memoryJournal());
    const result = await host.exec('gh', ['api', '--include', '--hostname', 'github.com', 'user'], {
      cwd: '.',
    });
    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.stdout, /^HTTP\/1\.1 200/);
    assert.match(result.stdout, new RegExp(`"login":"${LOGIN}"`));
  });

  it('lists the second order only once it is labelled, also for the next code host', async () => {
    const journal = memoryJournal();
    const first = await codeHost(journal);
    const labelled = `/repos/${BREWERY}/issues?labels=${ORDER.labels.join(',')}`;
    const numbers = async (host: { fetch: typeof fetch }) =>
      ((await (await send(host, 'GET', labelled)).json()) as { number: number }[]).map(
        ({ number }) => number,
      );
    assert.deepStrictEqual(await numbers(first), [ORDER.number]);
    const labels = `/repos/${BREWERY}/issues/${BREW_ORDER.number}/labels`;
    assert.equal((await send(first, 'POST', labels, { labels: ORDER.labels })).status, 200);
    assert.deepStrictEqual(await numbers(await codeHost(journal)), [
      ORDER.number,
      BREW_ORDER.number,
    ]);
  });

  it('keeps a pull request and a comment for the next code host opened on its journal', async () => {
    const journal = memoryJournal();
    const first = await codeHost(journal);
    const pull = { head: 'foedrum/demo.brewery/1-1/demo.web', base: 'main', title: 'T', body: 'B' };
    assert.equal((await send(first, 'POST', `/repos/${TARGET}/pulls`, pull)).status, 201);
    const comments = `/repos/${BREWERY}/issues/${ORDER.number}/comments`;
    assert.equal((await send(first, 'POST', comments, { body: 'Brewing' })).status, 201);

    const second = await codeHost(journal);
    assert.deepStrictEqual(
      second.pulls().map(({ head, title }) => ({ head, title })),
      [{ head: pull.head, title: 'T' }],
    );
    assert.deepStrictEqual(second.comments(BREWERY, ORDER.number), [
      { author: LOGIN, body: 'Brewing' },
    ]);
    // The same head is refused, as GitHub would refuse it.
    assert.equal((await send(second, 'POST', `/repos/${TARGET}/pulls`, pull)).status, 422);
    // An edit made after the restart lands on the comment made before it.
    const [made] = (await (await send(second, 'GET', comments)).json()) as { id: number }[];
    assert.equal(
      (
        await send(second, 'PATCH', `/repos/${BREWERY}/issues/comments/${made?.id}`, {
          body: 'On tap',
        })
      ).status,
      200,
    );
    const third = await codeHost(journal);
    assert.deepStrictEqual(third.comments(BREWERY, ORDER.number), [
      { author: LOGIN, body: 'On tap' },
    ]);
  });

  it('keeps no read', async () => {
    const journal = memoryJournal();
    const host = await codeHost(journal);
    await send(host, 'GET', `/repos/${TARGET}/pulls?head=demo:x`);
    await send(host, 'GET', `/repos/${BREWERY}/issues/${ORDER.number}`);
    assert.deepStrictEqual(journal.kept, []);
  });
});

describe('fileJournal', () => {
  let dir: TempDir;
  beforeEach(() => {
    dir = makeTempDir('demo-journal');
  });
  afterEach(() => dir.remove());

  it('has no line until one is appended, then each one in order, also when opened again', () => {
    const path = join(dir.path, 'code-host.jsonl');
    const journal = fileJournal(path);
    assert.deepStrictEqual(journal.lines(), []);
    journal.append('{"a":1}');
    journal.append('{"b":2}');
    assert.deepStrictEqual(fileJournal(path).lines(), ['{"a":1}', '{"b":2}']);
  });
});
