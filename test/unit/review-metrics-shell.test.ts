// node scripts/review-metrics.ts (#673): the shell reads the merged pull requests' comments through
// a GraphQL client, here a fake that answers from canned data, and prints the report.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type Deps, run } from '../../scripts/review-metrics.ts';

const fixtures = join(import.meta.dirname, '..', 'fixtures', 'review-metrics');
const text = (name: string): string => readFileSync(join(fixtures, name), 'utf8');

interface Node {
  url: string;
  body: string;
  isMinimized: boolean;
  authorAssociation: string;
}
type Answer = { data: unknown; errors: { message: string }[] };

const page = (nodes: Node[], endCursor: string | null): unknown => ({
  pageInfo: { hasNextPage: endCursor !== null, endCursor },
  nodes,
});
const pull = (merged: boolean, ...pages: unknown[]) => ({
  __typename: 'PullRequest',
  merged,
  pages,
});
const node = (
  url: string,
  body: string,
  isMinimized = false,
  authorAssociation = 'OWNER',
): Node => ({
  url,
  body,
  isMinimized,
  authorAssociation,
});

// #1 merged, its comments on two pages; #2 an issue; #3 not merged; #4 not there; #5 merged
// without a summary by an owner, member or collaborator.
const numbers: Record<number, ReturnType<typeof pull> | { __typename: 'Issue' }> = {
  1: pull(
    true,
    page([node('u1a', 'Thanks.'), node('u1b', text('rounds-in-prose.md'), true)], 'c1'),
    page([node('u1c', text('second-summary.md'))], null),
  ),
  2: { __typename: 'Issue' },
  3: pull(false, page([node('u3', text('template.md'))], null)),
  5: pull(
    true,
    page([node('u5', 'Looks good.'), node('u5b', text('template.md'), false, 'NONE')], null),
  ),
};

const fake = (calls: string[], newest = 5): Deps['client'] => ({
  graphql: async (query, variables): Promise<Answer> => {
    calls.push(JSON.stringify(variables));
    if (/pullRequests\(last: 1/.test(query)) {
      return {
        data: { repository: { pullRequests: { nodes: [{ number: newest }] } } },
        errors: [],
      };
    }
    const number = Number(variables.number);
    const found = numbers[number];
    if (found === undefined) {
      return {
        data: { repository: { issueOrPullRequest: null } },
        errors: [
          {
            message: `Could not resolve to an issue or pull request with the number of ${number}.`,
          },
        ],
      };
    }
    if (!('pages' in found))
      return { data: { repository: { issueOrPullRequest: found } }, errors: [] };
    const at = variables.after === null || variables.after === undefined ? 0 : 1;
    return {
      data: {
        repository: {
          issueOrPullRequest: {
            __typename: found.__typename,
            merged: found.merged,
            comments: found.pages[at],
          },
        },
      },
      errors: [],
    };
  },
});

const runWith = async (args: string[], deps: Partial<Deps> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[] = [];
  const code = await run(args, {
    client: fake(calls),
    origin: async () => 'https://github.com/owner/name.git',
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...deps,
  });
  return { code, out: out.join(''), err: err.join(''), calls };
};

describe('review-metrics', () => {
  it("passes each comment's author association on, so a summary by an outsider is listed apart (review of #683)", async () => {
    const { code, out } = await runWith(['--from', '5', '--to', '5']);
    assert.equal(code, 0);
    assert.match(out, /^- #5 u5b: posted by NONE, not by an owner, member or collaborator$/m);
  });

  it("reads every page of each merged pull request's comments and prints the report", async () => {
    const { code, out, err, calls } = await runWith(['--from', '1', '--to', '5']);
    assert.equal(err, '');
    assert.equal(code, 0);
    assert.match(
      out,
      /^Merged pull requests #1 to #5 of owner\/name: 2 merged, 1 not merged, 2 issues or missing\.$/m,
    );
    // rounds-in-prose.md (hidden, 2 rounds) and second-summary.md (one more).
    assert.match(out, /^\| #1 \| 2 \| 1 \| 3 \| 17 \|/m);
    assert.match(out, /^Without a summary: #5\.$/m);
    assert.doesNotMatch(out, /#3 \|/);
    assert.deepStrictEqual(
      calls.map((call) => JSON.parse(call)),
      [
        { owner: 'owner', name: 'name', number: 1, after: null },
        { owner: 'owner', name: 'name', number: 1, after: 'c1' },
        ...[2, 3, 4, 5].map((number) => ({ owner: 'owner', name: 'name', number, after: null })),
      ],
    );
  });

  it('reads up to the newest pull request when --to is not given, and from #1', async () => {
    const seen: string[] = [];
    const { code, out } = await runWith([], { client: fake(seen, 2) });
    assert.equal(code, 0);
    assert.match(out, /^Merged pull requests #1 to #2 of owner\/name:/m);
    assert.deepStrictEqual(
      seen.map((call) => JSON.parse(call).number),
      [undefined, 1, 1, 2],
    );
  });

  it("takes the repository from origin's URL, in its https and ssh forms, or from --repo", async () => {
    for (const url of ['https://github.com/owner/name', 'git@github.com:owner/name.git']) {
      const { out } = await runWith(['--from', '5', '--to', '5'], { origin: async () => url });
      assert.match(out, /of owner\/name:/);
    }
    const { out, calls } = await runWith(['--from', '5', '--to', '5', '--repo', 'other/repo']);
    assert.match(out, /of other\/repo:/);
    assert.equal(JSON.parse(calls[0] ?? '{}').owner, 'other');
  });

  it('refuses arguments it cannot read, and a repository it cannot tell, with exit 2', async () => {
    for (const args of [
      ['--from', 'x'],
      ['--from', '3', '--to', '2'],
      ['--to', '0'],
      ['--repo', 'name'],
      ['--other'],
    ]) {
      const { code, err } = await runWith(args);
      assert.equal(code, 2, args.join(' '));
      assert.match(err, /usage: node scripts\/review-metrics\.ts/, args.join(' '));
    }
    const { code, err } = await runWith(['--from', '1', '--to', '1'], {
      origin: async () => undefined,
    });
    assert.equal(code, 2);
    assert.match(err, /no origin to read the repository from: give --repo <owner\/name>/);
  });

  it('reads a pull request again once when its read throws, as a dropped connection does', async () => {
    const calls: string[] = [];
    const client = fake(calls);
    let thrown = 0;
    const { code, err, out } = await runWith(['--from', '1', '--to', '1'], {
      client: {
        graphql: async (query, variables, signal) => {
          if (variables.number === 1 && variables.after === 'c1' && thrown === 0) {
            thrown += 1;
            throw new Error('gh could not ask GitHub for POST graphql: read tcp: timed out');
          }
          return client.graphql(query, variables, signal);
        },
      },
    });
    assert.equal(err, '');
    assert.equal(code, 0);
    assert.match(out, /^\| #1 \| 2 \| 1 \| 3 \| 17 \|/m);
    assert.equal(calls.length, 3);
  });

  it('fails when the read throws again, with exit 1', async () => {
    const { code, err } = await runWith(['--from', '1', '--to', '1'], {
      client: {
        graphql: async () => {
          throw new Error('gh could not ask GitHub for POST graphql: read tcp: timed out');
        },
      },
    });
    assert.equal(code, 1);
    assert.equal(
      err,
      'reading #1 failed: gh could not ask GitHub for POST graphql: read tcp: timed out\n',
    );
  });

  it('reads a pull request again when a later page of its comments answers with no pull request (review of #683)', async () => {
    const calls: string[] = [];
    const client = fake(calls);
    let failed = 0;
    const { code, err, out } = await runWith(['--from', '1', '--to', '1'], {
      client: {
        graphql: async (query, variables, signal) => {
          if (variables.after === 'c1' && failed === 0) {
            failed += 1;
            return {
              data: { repository: { issueOrPullRequest: null } },
              errors: [{ message: 'Something went wrong while executing your query.' }],
            };
          }
          return client.graphql(query, variables, signal);
        },
      },
    });
    assert.equal(err, '');
    assert.equal(code, 0);
    assert.match(out, /: 1 merged, 0 not merged, 0 issues or missing\.$/m);
    assert.match(out, /^\| #1 \| 2 \| 1 \| 3 \| 17 \|/m);
  });

  it('fails on a number GitHub answers with no pull request and an error that is not its not-found (review of #683)', async () => {
    const { code, err } = await runWith(['--from', '4', '--to', '4'], {
      client: {
        graphql: async () => ({
          data: { repository: { issueOrPullRequest: null } },
          errors: [{ message: 'Something went wrong while executing your query.' }],
        }),
      },
    });
    assert.equal(code, 1);
    assert.equal(err, 'reading #4 failed: Something went wrong while executing your query.\n');
  });

  it('names the newest pull request when reading it fails (review of #683)', async () => {
    const { code, err } = await runWith([], {
      client: {
        graphql: async () => ({
          data: { repository: null },
          errors: [{ message: "Could not resolve to a Repository with the name 'owner/name'." }],
        }),
      },
    });
    assert.equal(code, 1);
    assert.equal(
      err,
      "reading the newest pull request failed: Could not resolve to a Repository with the name 'owner/name'.\n",
    );
  });

  it('fails with the error of a read that GitHub refused, with exit 1', async () => {
    const { code, err } = await runWith(['--from', '1', '--to', '1'], {
      client: {
        graphql: async () => ({ data: null, errors: [{ message: 'Bad credentials' }] }),
      },
    });
    assert.equal(code, 1);
    assert.equal(err, 'reading #1 failed: Bad credentials\n');
  });

  it('reads a pull request whose read keeps failing twice, no more (review of #683)', async () => {
    let calls = 0;
    const { code } = await runWith(['--from', '1', '--to', '1'], {
      client: {
        graphql: async () => {
          calls += 1;
          throw new Error('read tcp: timed out');
        },
      },
    });
    assert.equal(code, 1);
    assert.equal(calls, 2);
  });

  it('fails on a comment without its body (review of #683)', async () => {
    const { code, err } = await runWith(['--from', '1', '--to', '1'], {
      client: {
        graphql: async () => ({
          data: {
            repository: {
              issueOrPullRequest: {
                __typename: 'PullRequest',
                merged: true,
                comments: page([{ url: 'u', isMinimized: false } as unknown as Node], null),
              },
            },
          },
          errors: [],
        }),
      },
    });
    assert.equal(code, 1);
    assert.equal(err, 'reading #1 failed: a comment without its url or body\n');
  });

  it("fails on GitHub's not-found when another error comes with it (review of #683)", async () => {
    const { code, err } = await runWith(['--from', '4', '--to', '4'], {
      client: {
        graphql: async () => ({
          data: { repository: { issueOrPullRequest: null } },
          errors: [
            { message: 'Could not resolve to an issue or pull request with the number of 4.' },
            { message: 'Something went wrong while executing your query.' },
          ],
        }),
      },
    });
    assert.equal(code, 1);
    assert.equal(
      err,
      'reading #4 failed: Could not resolve to an issue or pull request with the number of 4.; Something went wrong while executing your query.\n',
    );
  });
});
