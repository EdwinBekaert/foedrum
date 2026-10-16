// The tracker and the marks against GitHub itself (ADR 0052): opt-in, with the same settings as the
// claim test (FOEDRUM_GITHUB_TEST_REPO, FOEDRUM_GITHUB_TEST_TOKEN); skipped otherwise, in CI
// included. It only reads: GitHub's real answers must pass the schemas the unit tests' synthetic
// answers stand in for, and an unchanged listing must come back as a 304.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGitHubClient } from '../../src/github/client.ts';
import { githubIssueMarks } from '../../src/github/marks.ts';
import { createGitHubReads } from '../../src/github/reads.ts';
import { githubTargetTracker } from '../../src/github/tracker.ts';

const repo = process.env.FOEDRUM_GITHUB_TEST_REPO;
const token = process.env.FOEDRUM_GITHUB_TEST_TOKEN;
const enabled = repo !== undefined && repo !== '' && token !== undefined && token !== '';

describe('the GitHub tracker and marks on GitHub', {
  skip: !enabled && 'set FOEDRUM_GITHUB_TEST_REPO and FOEDRUM_GITHUB_TEST_TOKEN',
}, () => {
  const target = repo ?? '';
  const statuses: number[] = [];
  // The real fetch, with each answer's status noted.
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const response = await globalThis.fetch(input, init);
    statuses.push(response.status);
    return response;
  };
  const client = createGitHubClient({ token: token ?? '', fetch });
  const reads = createGitHubReads(client);
  const tracker = githubTargetTracker(reads);
  const marks = githubIssueMarks({ client, reads, login: 'foedrum-test-nobody' });

  it('lists the open issues, and answers an unchanged listing from a 304', async () => {
    const first = await tracker.issues(target);
    statuses.length = 0;
    const again = await tracker.issues(target);
    assert.deepStrictEqual(again, first);
    // An issue may change in between; every page that did not came back as a 304.
    assert.ok(statuses.includes(304), `no 304 among ${statuses.join(', ')}`);
  });

  it('reads the marks and the comments of an issue, and how a pull request stands', async () => {
    const listed = await tracker.issues(target);
    const issue = listed.find((item) => !item.pullRequest);
    if (issue !== undefined) {
      assert.ok(Array.isArray(await marks.assignees(target, issue.number)));
      assert.deepStrictEqual(await marks.labels(target, issue.number), issue.labels);
      const marker = '<!-- foedrum:["no-such-batch","claim.comment"] -->';
      assert.equal(await marks.findComment(target, issue.number, marker), undefined);
    }
    const pull = listed.find((item) => item.pullRequest);
    if (pull !== undefined) {
      const url = `https://github.com/${target}/pull/${pull.number}`;
      assert.equal(await tracker.pullRequest(url), 'open');
    }
  });
});
