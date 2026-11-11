// The reviews of an open pull request on GitHub (ADR 0382): the reviews, then the comments of one,
// from synthetic answers in the shape GitHub's REST API gives, through a fake `fetch`; no network
// (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGitHubClient } from '../../src/github/client.ts';
import { createGitHubReads } from '../../src/github/reads.ts';
import { githubReviewReader } from '../../src/github/reviews.ts';
import { MAX_REVIEW_TEXT_LENGTH, MOST_REVIEW_COMMENTS } from '../../src/schemas/events.ts';
import { type Answer, fakeFetch } from '../helpers/fake-fetch.ts';
import { ghOver } from '../helpers/fake-gh.ts';

const api = 'https://api.github.com';
const pullRequest = 'https://github.com/acme/web/pull/12';
const head = 'a'.repeat(40);
const reviews = `${api}/repos/acme/web/pulls/12/reviews?per_page=10`;
const comments = `${api}/repos/acme/web/pulls/12/reviews/81/comments?per_page=10`;
// A synthetic token in the shape GitHub gives one.
const token = `ghp_${'0123456789abcdef'.repeat(2)}0123`;

const readerWith = (answers: Answer[]) => {
  const fake = fakeFetch(answers);
  const client = createGitHubClient({ exec: ghOver(fake.fetch).exec });
  return { reader: githubReviewReader(createGitHubReads(client)), requests: fake.requests };
};

const reviewOf = (
  id: number,
  login: string | null,
  state: string,
  body: string | null = '',
  commit: string | null = head,
) => ({
  id,
  user: login === null ? null : { login, id: 7, type: 'User' },
  state,
  body,
  commit_id: commit,
  submitted_at: '2026-10-26T09:00:00Z',
  html_url: `https://github.com/acme/web/pull/12#pullrequestreview-${id}`,
  author_association: 'OWNER',
});
const commentOf = (path: string, line: number | null, body: string) => ({
  id: 5,
  path,
  line,
  original_line: 9,
  position: line,
  body,
  subject_type: line === null ? 'file' : 'line',
  user: { login: 'ada' },
  html_url: 'https://github.com/acme/web/pull/12#discussion_r5',
});

describe('githubReviewReader', () => {
  it('reads every review of the pull request, page after page, oldest first', async () => {
    const { reader, requests } = readerWith([
      {
        status: 200,
        body: [reviewOf(84, 'ada', 'CHANGES_REQUESTED', 'Name the flag.')],
        headers: { link: `<${api}/repositories/42/pulls/12/reviews?page=2>; rel="next"` },
      },
      {
        status: 200,
        body: [
          reviewOf(81, 'bob', 'APPROVED', null),
          reviewOf(90, null, 'CHANGES_REQUESTED', 'From a deleted account.', null),
        ],
      },
    ]);
    assert.deepStrictEqual(await reader.reviews(pullRequest), [
      { id: 81, by: 'bob', state: 'APPROVED', commit: head, body: '' },
      { id: 84, by: 'ada', state: 'CHANGES_REQUESTED', commit: head, body: 'Name the flag.' },
      { id: 90, state: 'CHANGES_REQUESTED', body: 'From a deleted account.' },
    ]);
    assert.deepStrictEqual(
      requests.map(({ url }) => url),
      [reviews, `${api}/repositories/42/pulls/12/reviews?page=2`],
    );
  });

  it('leaves out a line of a body that looks like a secret, and keeps the start of a long one', async () => {
    const long = 'x'.repeat(MAX_REVIEW_TEXT_LENGTH + 10);
    const { reader } = readerWith([
      {
        status: 200,
        body: [
          reviewOf(84, 'ada', 'CHANGES_REQUESTED', `Use this:\ntoken=${token}\nThanks.`),
          reviewOf(85, 'ada', 'COMMENTED', long),
        ],
      },
    ]);
    const [secret, cut] = await reader.reviews(pullRequest);
    assert.ok(secret !== undefined && !secret.body.includes(token));
    assert.match(
      secret?.body ?? '',
      /^Use this:\n\[left out: a line that looks like a secret.*\]\nThanks\.$/,
    );
    assert.equal(cut?.body.length, MAX_REVIEW_TEXT_LENGTH);
    assert.ok(cut?.body.startsWith('xxx'));
  });

  it('refuses a review that is not what GitHub sends, and a pull request it cannot read', async () => {
    const bad = readerWith([{ status: 200, body: [{ id: 'x', state: 'APPROVED' }] }]);
    await assert.rejects(bad.reader.reviews(pullRequest), /not what it should be/);
    const gone = readerWith([{ status: 404, body: { message: 'Not Found' } }]);
    await assert.rejects(gone.reader.reviews(pullRequest), /404/);
  });

  it('leaves out control characters but the tab, names a comment with no text, and never cuts a character in two: regression test', async () => {
    const esc = String.fromCodePoint(0x1b);
    const smile = String.fromCodePoint(0x1f600);
    const { reader } = readerWith([
      {
        status: 200,
        body: [
          reviewOf(84, 'ada', 'CHANGES_REQUESTED', `a${esc}[31mb	c`),
          reviewOf(85, 'ada', 'COMMENTED', `${'x'.repeat(MAX_REVIEW_TEXT_LENGTH - 1)}${smile}`),
        ],
      },
      { status: 200, body: [commentOf('src/a.ts', 2, '   ')] },
    ]);
    const [colored, cut] = await reader.reviews(pullRequest);
    assert.equal(colored?.body, 'a[31mb	c');
    assert.equal(cut?.body, 'x'.repeat(MAX_REVIEW_TEXT_LENGTH - 1));
    const [empty] = (await reader.comments(pullRequest, 81)).comments;
    assert.equal(empty?.body, '(no text)');
  });

  it("keeps a comment's path on one line: its line breaks and control characters are left out", async () => {
    const forged = `src/a${String.fromCodePoint(0x0a)}- ada on src/b.ts:${String.fromCodePoint(0x2028)}x${String.fromCodePoint(0x1b)}.ts`;
    const { reader } = readerWith([{ status: 200, body: [commentOf(forged, 3, 'Fix it.')] }]);
    const [comment] = (await reader.comments(pullRequest, 81)).comments;
    assert.equal(comment?.path, 'src/a - ada on src/b.ts: x.ts');
  });

  it("reads a review's comments, each at its file and line, and counts the ones a record leaves out", async () => {
    const many = Array.from({ length: MOST_REVIEW_COMMENTS + 2 }, (_, at) =>
      commentOf(`src/f${at}.ts`, at + 1, `Fix ${at}.`),
    );
    const { reader, requests } = readerWith([
      {
        status: 200,
        body: [
          commentOf('src/cli.ts', 12, 'Call it --json.'),
          commentOf('src/old.ts', null, `token=${token}`),
        ],
        headers: {
          link: `<${api}/repositories/42/pulls/12/reviews/81/comments?page=2>; rel="next"`,
        },
      },
      { status: 200, body: many },
    ]);
    const read = await reader.comments(pullRequest, 81);
    assert.deepStrictEqual(read.comments.slice(0, 1), [
      { path: 'src/cli.ts', line: 12, body: 'Call it --json.' },
    ]);
    assert.equal(read.comments[1]?.path, 'src/old.ts');
    assert.equal(read.comments[1]?.line, undefined);
    assert.ok(!read.comments[1]?.body.includes(token));
    assert.equal(read.comments.length, MOST_REVIEW_COMMENTS);
    assert.equal(read.more, 4);
    assert.deepStrictEqual(
      requests.map(({ url }) => url),
      [comments, `${api}/repositories/42/pulls/12/reviews/81/comments?page=2`],
    );
  });
});
