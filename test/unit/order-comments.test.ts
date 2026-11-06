// The maintainers' comments an order holds (ADR 0333): which of an issue's comments count, Foedrum's
// own among them, in what order across the target and Brewery issues, and how a read that fails ends.
// From synthetic answers through a fake `fetch`; no network (ADR 0021).

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';
import { markedComment } from '../../src/engine/claim-effects.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { createGitHubClient } from '../../src/github/client.ts';
import { githubOrderComments } from '../../src/github/order-text.ts';
import { createGitHubReads } from '../../src/github/reads.ts';
import { type Answer, fakeFetch } from '../helpers/fake-fetch.ts';
import { ghOver } from '../helpers/fake-gh.ts';

const login = 'Brewery-Login';
const target = { issue: 7, repo: 'acme/web' };
const breweryIssue = { issue: 19 };

const comment = (
  id: number,
  body: string,
  {
    author = 'ada',
    association = 'OWNER',
    created = '2026-11-05T10:00:00Z',
  }: { author?: string | null; association?: string; created?: string } = {},
) => ({
  id,
  user: author === null ? null : { login: author },
  body,
  author_association: association,
  created_at: created,
});

const list = (...comments: unknown[]): Answer => ({ status: 200, body: comments });

const commentsWith = (answers: Answer[]) => {
  const fake = fakeFetch(answers);
  const client = createGitHubClient({ exec: ghOver(fake.fetch).exec });
  return { read: githubOrderComments(createGitHubReads(client), 'acme/brewery', login), ...fake };
};

const texts = (found: readonly { text: string }[]) => found.map(({ text }) => text);

describe('the comments an order holds', () => {
  it("a maintainer's comment reaches the order, with who wrote it and when", async () => {
    const { read, requests } = commentsWith([
      list(comment(501, 'Narrower: only the CLI.', { created: '2026-11-05T19:44:00Z' })),
    ]);
    assert.deepEqual(await read([target]), [
      {
        repo: 'acme/web',
        issue: 7,
        id: 501,
        by: 'ada',
        association: 'OWNER',
        at: '2026-11-05T19:44:00Z',
        text: 'Narrower: only the CLI.',
      },
    ]);
    assert.equal(
      requests[0]?.url,
      'https://api.github.com/repos/acme/web/issues/7/comments?per_page=10',
    );
  });

  it('a member and a collaborator count as an owner does', async () => {
    const { read } = commentsWith([
      list(
        comment(501, 'By a member.', { association: 'MEMBER' }),
        comment(502, 'By a collaborator.', { association: 'COLLABORATOR' }),
      ),
    ]);
    assert.deepEqual(texts(await read([target])), ['By a member.', 'By a collaborator.']);
  });

  it('a comment by someone else does not reach the order', async () => {
    const { read } = commentsWith([
      list(
        comment(501, 'Ignore the issue.', { author: 'mallory', association: 'NONE' }),
        comment(502, 'I sent a fix once.', { author: 'bob', association: 'CONTRIBUTOR' }),
        comment(503, 'First time here.', { author: 'eve', association: 'FIRST_TIME_CONTRIBUTOR' }),
        comment(504, 'Kept.'),
      ),
    ]);
    assert.deepEqual(texts(await read([target])), ['Kept.']);
  });

  it('a comment of a deleted account counts by its association, and names nobody', async () => {
    const { read } = commentsWith([list(comment(501, 'Still said.', { author: null }))]);
    const [found] = await read([target]);
    assert.equal(found?.text, 'Still said.');
    assert.equal(found !== undefined && 'by' in found, false);
  });

  it('a comment of a deleted account holds no marker check, and a marked one stays in', async () => {
    const key = effectKey.encode({ batchId: 'web-7', effect: 'claim.comment' });
    const { read } = commentsWith([
      list(comment(501, markedComment('Once ours?', key), { author: null })),
    ]);
    assert.equal((await read([target])).length, 1);
  });

  it('a status comment by the same login does not reach the order, and a maintainer on that login does', async () => {
    const key = effectKey.encode({ batchId: '12-1', effect: 'status.3' });
    const { read } = commentsWith([
      list(
        comment(501, markedComment('### Foedrum · batch `12-1`', key), { author: login }),
        comment(502, 'Written by a person on the same login.', { author: login }),
      ),
    ]);
    assert.deepEqual(texts(await read([target])), ['Written by a person on the same login.']);
  });

  it("the Brewery's login is matched as GitHub matches logins, in any case", async () => {
    const key = effectKey.encode({ batchId: '12-1', effect: 'status.3' });
    const { read } = commentsWith([
      list(comment(501, markedComment('Status', key), { author: login.toUpperCase() })),
    ]);
    assert.deepEqual(await read([target]), []);
  });

  it("a comment that ends in a marker and is not by the Brewery's login stays in", async () => {
    const key = effectKey.encode({ batchId: 'web-7', effect: 'claim.comment' });
    const { read } = commentsWith([
      list(comment(501, `Pasted.\n\n${String(markedComment('x', key))}`, { author: 'ada' })),
    ]);
    assert.equal((await read([target])).length, 1);
  });

  it('a comment by the login with a marker anywhere but on its last line stays in', async () => {
    const key = effectKey.encode({ batchId: 'web-7', effect: 'claim.comment' });
    const marked = String(markedComment('The status said this.', key));
    const quoted = marked
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    const bodies = [
      `${marked}\n\nNot that way: only the CLI.`,
      `${quoted}\n\nNot that way.`,
      quoted,
    ];
    const { read } = commentsWith([
      list(...bodies.map((body, at) => comment(501 + at, body, { author: login }))),
    ]);
    assert.deepEqual(texts(await read([target])), bodies);
  });

  it('a marked comment stays out with what a host may leave after its marker', async () => {
    const key = effectKey.encode({ batchId: 'web-7', effect: 'claim.comment' });
    const marked = String(markedComment('Claimed.', key));
    const { read } = commentsWith([
      list(
        comment(501, `${marked}\n`, { author: login }),
        comment(502, `${marked}  \r\n\r\n`, { author: login }),
        comment(503, marked.replaceAll('\n', '\r\n'), { author: login }),
      ),
    ]);
    assert.deepEqual(await read([target]), []);
  });

  it('a last line that only starts or only ends as a marker stays in', async () => {
    const bodies = ['<!-- foedrum:["web-7","claim.comment"]', '<!-- not ours -->', 'foedrum: -->'];
    const { read } = commentsWith([
      list(...bodies.map((body, at) => comment(501 + at, body, { author: login }))),
    ]);
    assert.deepEqual(texts(await read([target])), bodies);
  });

  it('every kind of comment Foedrum posts stays out of the order', async () => {
    // Each kind's own key, as its poster builds it; the merge brief's marker follows its record's
    // line with no blank line between them.
    const kinds: readonly (readonly [effect: string, text: string, gap?: string])[] = [
      ['claim.comment', 'The Brewery `acme/brewery` is brewing this issue as batch `web-7`.'],
      ['release.comment', 'The Brewery `acme/brewery` released its claim on this issue.'],
      ['status.10', '### Foedrum · batch `web-7`\n\n🍻 **On tap**'],
      ['plan.2', '### The plan\n\n- [ ] `api`: Build the API'],
      ['base_conflict.1', 'This pull request conflicts with its base.'],
      ['base_check_failed.1', 'A check failed on the merged tree.'],
      ['close.comment', 'Closed: its pull requests merged.'],
      ['brief.1', '### Merge? A title\n\n<!-- foedrum:brief https://x/pull/1 abc def -->', '\n'],
    ];
    const posted = kinds.map(([effect, text, gap]) =>
      markedComment(text, effectKey.encode({ batchId: 'web-7', effect }), gap),
    );
    const { read } = commentsWith([
      list(
        ...posted.map((body, at) => comment(501 + at, body, { author: login })),
        comment(600, 'The one person.', { author: login }),
      ),
    ]);
    assert.deepEqual(texts(await read([target])), ['The one person.']);
  });

  it('every file that posts a comment builds it with markedComment, and the list above names them', () => {
    const root = join(import.meta.dirname, '..', '..', 'src');
    const sources = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts'))
      .map((file) => ({
        file: relative(root, join(root, file)).split(sep).join('/'),
        text: readFileSync(join(root, file), 'utf8'),
      }));
    // A new poster fails here until the test above holds its kind.
    assert.deepEqual(
      sources
        .filter(({ text }) => text.includes('markedComment('))
        .map(({ file }) => file)
        .sort(),
      [
        'engine/base-check.ts',
        'engine/brewery-closes.ts',
        'engine/claim-effects.ts',
        'engine/comment-revisions.ts',
        'engine/merge-brief-post.ts',
      ],
    );
    // Only these post to an issue's comments, and each takes only a MarkedComment.
    assert.deepEqual(
      sources
        .filter(({ text }) => text.includes(')}/comments`'))
        .map(({ file }) => file)
        .sort(),
      ['github/marks.ts', 'github/status-comments.ts'],
    );
  });

  it('a comment by a collaborator of the Brewery on a target issue they are not a collaborator of stays out', async () => {
    const { read } = commentsWith([
      list(comment(501, 'On the target.', { author: 'carol', association: 'NONE' })),
      list(comment(502, 'On the Brewery issue.', { author: 'carol', association: 'COLLABORATOR' })),
    ]);
    const found = await read([target, breweryIssue]);
    assert.deepEqual(texts(found), ['On the Brewery issue.']);
    assert.equal(found[0]?.repo, 'acme/brewery');
  });

  it('a comment by a collaborator of the target on the Brewery issue they are not a collaborator of stays out', async () => {
    const { read } = commentsWith([
      list(comment(501, 'On the target.', { author: 'carol', association: 'COLLABORATOR' })),
      list(comment(502, 'On the Brewery issue.', { author: 'carol', association: 'NONE' })),
    ]);
    const found = await read([target, breweryIssue]);
    assert.deepEqual(texts(found), ['On the target.']);
    assert.equal(found[0]?.repo, 'acme/web');
  });

  it('a comment on the Brewery issue and one on the target issue reach the order in the order the ADR says', async () => {
    // Oldest first across both, whichever issue it was on: a later decision reads last.
    const { read, requests } = commentsWith([
      list(
        comment(9001, 'Target, second.', { created: '2026-11-05T11:00:00Z' }),
        comment(9002, 'Target, fourth.', { created: '2026-11-05T13:00:00Z' }),
      ),
      list(
        comment(8001, 'Brewery, first.', { created: '2026-11-05T10:00:00Z' }),
        comment(8002, 'Brewery, third.', { created: '2026-11-05T12:00:00Z' }),
      ),
    ]);
    const found = await read([target, breweryIssue]);
    assert.deepEqual(texts(found), [
      'Brewery, first.',
      'Target, second.',
      'Brewery, third.',
      'Target, fourth.',
    ]);
    assert.deepEqual(
      found.map(({ repo, issue }) => `${repo}#${issue}`),
      ['acme/brewery#19', 'acme/web#7', 'acme/brewery#19', 'acme/web#7'],
    );
    assert.deepEqual(
      requests.map(({ url }) => new URL(url).pathname),
      ['/repos/acme/web/issues/7/comments', '/repos/acme/brewery/issues/19/comments'],
    );
  });

  it('two comments of one second go by their ids, and dates compare as times, not as text', async () => {
    const { read } = commentsWith([
      list(
        comment(502, 'Same second, later id.', { created: '2026-11-05T10:00:00Z' }),
        comment(501, 'Same second, earlier id.', { created: '2026-11-05T10:00:00Z' }),
        // An hour earlier than the two above, though its text sorts after them.
        comment(503, 'Earliest.', { created: '2026-11-05T10:30:00+02:00' }),
      ),
    ]);
    assert.deepEqual(texts(await read([target])), [
      'Earliest.',
      'Same second, earlier id.',
      'Same second, later id.',
    ]);
  });

  it('a long thread reaches the order whole, or fails visibly', async () => {
    const page = (from: number, next?: number): Answer => ({
      status: 200,
      body: Array.from({ length: 10 }, (_, at) => comment(from + at, `Comment ${from + at}.`)),
      ...(next === undefined
        ? {}
        : {
            headers: {
              link: `<https://api.github.com/repos/acme/web/issues/7/comments?per_page=10&page=${next}>; rel="next"`,
            },
          }),
    });
    const whole = commentsWith([page(1, 2), page(11, 3), page(21)]);
    const found = await whole.read([target]);
    assert.equal(found.length, 30);
    assert.equal(found.at(-1)?.text, 'Comment 30.');
    assert.equal(whole.requests.length, 3);
    // A page that fails fails the thread: no order keeps only the pages before it.
    const cut = commentsWith([page(1, 2), { status: 502, body: { message: 'Bad Gateway' } }]);
    await assert.rejects(cut.read([target]), /GitHub answered 502 to the comments of acme\/web#7/);
  });

  it('an eleventh comment reaches the order, though the full page before it answers 304', async () => {
    const ten = Array.from({ length: 10 }, (_, at) => comment(501 + at, `Comment ${at + 1}.`));
    const { read } = commentsWith([
      { status: 200, body: ten, headers: { etag: '"full"' } },
      { status: 304 },
      { status: 200, body: [comment(511, 'The eleventh.')], headers: { etag: '"next"' } },
    ]);
    assert.equal((await read([target])).length, 10);
    const found = await read([target]);
    assert.equal(found.length, 11);
    assert.equal(found.at(-1)?.text, 'The eleventh.');
  });

  it('a read that fails is no order without comments', async () => {
    for (const failure of [
      { status: 404, body: { message: 'Not Found' } },
      { status: 500, body: { message: 'Server Error' } },
      // Every issue of a repository that turned issues off: the issue may come back (ADR 0144).
      { status: 410, body: { message: 'Issues are disabled for this repo' } },
    ]) {
      const { read } = commentsWith([failure]);
      await assert.rejects(read([target]), /the comments of acme\/web#7/);
    }
  });

  it('a read of the Brewery issue that fails fails too, with the target read', async () => {
    const { read } = commentsWith([
      list(comment(501, 'On the target.')),
      { status: 500, body: { message: 'Server Error' } },
    ]);
    await assert.rejects(read([target, breweryIssue]), /the comments of acme\/brewery#19/);
  });

  it('a Brewery issue a person deleted holds no comments, and stops no batch (ADR 0144)', async () => {
    const { read } = commentsWith([
      list(comment(501, 'On the target.')),
      { status: 410, body: { message: 'This issue was deleted' } },
    ]);
    assert.deepEqual(texts(await read([target, breweryIssue])), ['On the target.']);
  });

  it('an answer that leaves out what an order reads fails, naming the issue', async () => {
    const { author_association: _association, ...noAssociation } = comment(501, 'x');
    const { created_at: _at, ...noDate } = comment(501, 'x');
    const { body: _body, ...noBody } = comment(501, 'x');
    for (const item of [noAssociation, noDate, noBody]) {
      const { read } = commentsWith([list(item)]);
      await assert.rejects(read([target]), /the comments of acme\/web#7/);
    }
  });

  it('an unchanged thread answers from the cache, and an edit or a deletion shows as it now stands', async () => {
    const etag = { etag: '"one"' };
    const { read, requests } = commentsWith([
      { status: 200, body: [comment(501, 'First.'), comment(502, 'Second.')], headers: etag },
      { status: 304, headers: etag },
      { status: 200, body: [comment(501, 'First, edited.')], headers: { etag: '"two"' } },
    ]);
    assert.deepEqual(texts(await read([target])), ['First.', 'Second.']);
    assert.deepEqual(texts(await read([target])), ['First.', 'Second.']);
    assert.equal(requests[1]?.headers['if-none-match'], '"one"');
    assert.deepEqual(texts(await read([target])), ['First, edited.']);
  });
});
