// A fake GitHub API behind a `fetch`, for `foedrum serve`'s tests (ADR 0068): the issues of each
// repository, its claim refs with their commits, the marks of its issues, its pull requests, which
// a test merges, and its releases, which a test makes as a repository's CI would, answered by
// method and path the way the GitHub layer asks (src/github/). No network (ADR 0021).

export interface FakeApiIssue {
  number: number;
  labels: string[];
  author: string;
  assignees?: string[];
  body?: string;
  title?: string;
  state?: 'open' | 'closed';
  /** When it was created; by default a minute after 2026-10-01 per issue number. */
  created?: string;
  /** Its REST id, which the links name it by; by default `idOf` its number. */
  id?: number;
  /** The numbers of its sub-issues, in their order. */
  subIssues?: number[];
  /** The numbers of the issues it is blocked by. */
  blockedBy?: number[];
}

/** The REST id the fake gives an issue that names none: never its number, as on GitHub. */
export const idOf = (number: number): number => 6_000_000_000 + number;

/** The creation time the fake gives an issue that names none: one minute per issue number. */
export const createdOf = (number: number): string =>
  new Date(Date.UTC(2026, 9, 1) + number * 60_000).toISOString();

/**
 * The commit a pull request the fake opened heads: one per number, zero-padded after an `e`, never a
 * commit the fake made (zero-padded from the start), so a test can tell it from them.
 */
export const headOf = (number: number): string => `e${number.toString(16).padStart(39, '0')}`;

/** A comment on an issue, which a test may put there as a person would. */
export interface FakeApiComment {
  id: number;
  author: string;
  body: string;
  /** How its author stands to the repository; by default `OWNER` for the token's login, else `NONE`. */
  association?: string;
  /** When it was made; by default a minute after 2026-10-01 per comment id. */
  created?: string;
}

/** The node id GraphQL names a pull request the fake opened by (ADR 0350). */
export const pullNode = (pull: { repo: string; number: number }): string =>
  `PR_${pull.repo}#${pull.number}`;

/** A pull request the fake opened, as `POST /repos/{owner}/{repo}/pulls` asked for it. */
export interface FakeApiPull {
  repo: string;
  number: number;
  author: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
  /** Its merge, once `merge` made it: the merge commit and when it merged. */
  merged?: FakeApiMerge;
}

/** A merge of a pull request: its merge commit, made where the test merged it, and when. */
export interface FakeApiMerge {
  sha: string;
  at: string;
}

/**
 * A release of a repository, as its CI would make it: a tag on `commit` at `at`, published as a
 * release with `notes`, or with `tagOnly` a tag with no release.
 */
export interface FakeApiRelease {
  tag: string;
  commit: string;
  at: string;
  notes?: string;
  tagOnly?: boolean;
}

/** Who can read a repository, as `GET /repos/{owner}/{repo}` says. */
export type FakeApiVisibility = 'public' | 'private' | 'internal';

/** An answer to send instead of the fake's own; `hang` never answers until its signal aborts. */
export type Instead = { status: number; body?: unknown; headers?: Record<string, string> } | 'hang';

export interface FakeGitHubApiOptions {
  /** The login of the token. */
  login: string;
  /** The open issues of each repository, by `owner/name` in lower case. */
  issues: Record<string, FakeApiIssue[]>;
  /** Who can read each repository, by `owner/name` in lower case; any other is not found. */
  visibilities?: Record<string, FakeApiVisibility>;
  /** The answer to send instead for a request, or undefined for the fake's own. */
  instead?: (method: string, url: URL) => Instead | undefined;
}

export interface FakeGitHubApi {
  fetch: typeof globalThis.fetch;
  /** Every request, as `<METHOD> <path and query>`. */
  readonly requests: string[];
  /** The claim refs there now, as `<repo> <ref>`, with the commit each points at. */
  readonly refs: Map<string, string>;
  /** Every claim ref ever created, as `<repo> <ref>`. */
  readonly created: string[];
  /** Every pull request opened, in order. */
  readonly pulls: FakeApiPull[];
  /** The comments on each issue, by `<repo>#<n>` in lower case. */
  readonly comments: Map<string, FakeApiComment[]>;
  /** The labels made in each repository, by `owner/name` in lower case. */
  readonly labels: Map<string, Set<string>>;
  issue(repo: string, number: number): FakeApiIssue | undefined;
  /** The issues of each repository, those opened through the API included (ADR 0144). */
  readonly issues: Record<string, FakeApiIssue[]>;
  /** Merges the pull request `repo#number` it opened, as a person would on GitHub. */
  merge(repo: string, number: number, merged: FakeApiMerge): void;
  /** Releases `repo`, holding every merge of it made before. */
  release(repo: string, release: FakeApiRelease): void;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const notFound = (): Response => json(404, { message: 'Not Found' });

export const fakeGitHubApi = (options: FakeGitHubApiOptions): FakeGitHubApi => {
  const { login } = options;
  const requests: string[] = [];
  const refs = new Map<string, string>();
  const created: string[] = [];
  // The message of each commit made.
  const messages = new Map<string, string>();
  const comments = new Map<string, FakeApiComment[]>();
  // A comment as GitHub answers it: Foedrum posts with gh's login, so its own read as `OWNER`.
  const asComment = ({ id, author, body, association, created }: FakeApiComment) => ({
    id,
    user: { login: author },
    body,
    author_association: association ?? (author === login ? 'OWNER' : 'NONE'),
    created_at: created ?? createdOf(id),
  });
  const labels = new Map<string, Set<string>>();
  // The releases of each repository, in the order made, each with the merges made before it.
  const releases = new Map<string, (FakeApiRelease & { held: string[] })[]>();
  const releasesOf = (repo: string) => releases.get(repo.toLowerCase()) ?? [];
  /** The one of `made` with the latest date, or undefined when there is none. */
  const newest = <T extends { at: string }>(made: readonly T[]): T | undefined =>
    made.reduce<T | undefined>(
      (latest, each) =>
        latest === undefined || Date.parse(each.at) > Date.parse(latest.at) ? each : latest,
      undefined,
    );
  let ids = 0;
  let commits = 0;
  const repoIssues = (repo: string): FakeApiIssue[] => options.issues[repo.toLowerCase()] ?? [];
  // An issue opened through the API, numbered after every issue and pull request of its repository.
  const openIssue = (
    repo: string,
    fields: { title?: string; body?: string; labels?: string[] },
  ): FakeApiIssue => {
    const key = repo.toLowerCase();
    const listed = options.issues[key] ?? [];
    options.issues[key] = listed;
    const numbers = [
      ...listed.map((each) => each.number),
      ...pulls.filter((pull) => pull.repo === key).map((pull) => pull.number),
    ];
    const made: FakeApiIssue = {
      number: Math.max(0, ...numbers) + 1,
      labels: [...(fields.labels ?? [])],
      author: login,
      title: fields.title ?? '',
      body: fields.body ?? '',
      state: 'open',
    };
    listed.push(made);
    return made;
  };
  const issue = (repo: string, number: number) =>
    repoIssues(repo).find((each) => each.number === number);
  const asIssue = (found: FakeApiIssue) => ({
    id: found.id ?? idOf(found.number),
    number: found.number,
    state: found.state ?? 'open',
    user: { login: found.author },
    labels: found.labels.map((name) => ({ name })),
    assignees: (found.assignees ?? []).map((assignee) => ({ login: assignee })),
    body: found.body ?? null,
    created_at: found.created ?? createdOf(found.number),
    ...(found.title === undefined ? {} : { title: found.title }),
  });
  const labelsOf = (found: FakeApiIssue) => found.labels.map((name) => ({ name }));

  // The GraphQL requests of the claim host, a repository's id and a conditional delete, and the
  // release reader's newest tag by its commit's date.
  const graphql = (body: unknown): Response => {
    const { query, variables } = body as { query: string; variables: Record<string, unknown> };
    if (query.includes('refs(refPrefix: "refs/tags/"')) {
      const tag = newest(releasesOf(`${variables.owner}/${variables.name}`));
      const nodes = tag === undefined ? [] : [{ name: tag.tag, target: { committedDate: tag.at } }];
      return json(200, { data: { repository: { refs: { nodes } } } });
    }
    if (query.includes('repository(')) {
      return json(200, { data: { repository: { id: `R_${variables.owner}/${variables.name}` } } });
    }
    // A pull request marked ready for review, or turned back into a draft (ADR 0350).
    const drafting = /markPullRequestReadyForReview|convertPullRequestToDraft/.exec(query)?.[0];
    if (drafting !== undefined) {
      const { pullRequestId } = (variables as { input: { pullRequestId: string } }).input;
      const pull = pulls.find((each) => pullNode(each) === pullRequestId);
      if (pull === undefined) {
        return json(200, { data: null, errors: [{ message: 'Could not resolve to a node' }] });
      }
      pull.draft = drafting === 'convertPullRequestToDraft';
      return json(200, { data: { [drafting]: { pullRequest: { isDraft: pull.draft } } } });
    }
    const { input } = variables as {
      input: { repositoryId: string; refUpdates: { name: string; beforeOid: string }[] };
    };
    const repo = input.repositoryId.slice('R_'.length);
    for (const { name, beforeOid } of input.refUpdates) {
      if (refs.get(`${repo} ${name}`) !== beforeOid) {
        return json(200, { data: null, errors: [{ message: 'Something went wrong' }] });
      }
      refs.delete(`${repo} ${name}`);
    }
    return json(200, { data: { updateRefs: { clientMutationId: null } } });
  };

  // An issue's sub-issues and "blocked by" links (spike #18): each names the other issue by its
  // REST id, a number where the id belongs is not found, and a repeated add answers 422.
  const onLinks = (
    method: string,
    repo: string,
    found: FakeApiIssue,
    what: 'sub_issues' | 'blocked_by',
    body: unknown,
  ): Response => {
    if (what === 'sub_issues') found.subIssues ??= [];
    else found.blockedBy ??= [];
    const linked = (what === 'sub_issues' ? found.subIssues : found.blockedBy) ?? [];
    if (method === 'GET') {
      const listed = linked.flatMap((number) => {
        const each = issue(repo, number);
        return each === undefined ? [] : [asIssue(each)];
      });
      return json(200, listed);
    }
    if (method !== 'POST') return notFound();
    const fields = (body ?? {}) as { sub_issue_id?: number; issue_id?: number };
    const id = what === 'sub_issues' ? fields.sub_issue_id : fields.issue_id;
    const other = repoIssues(repo).find((each) => (each.id ?? idOf(each.number)) === id);
    if (other === undefined) return notFound();
    if (what === 'sub_issues') {
      const parented = repoIssues(repo).some((each) => each.subIssues?.includes(other.number));
      if (parented) {
        return json(422, {
          message:
            'An error occurred while adding the sub-issue to the parent issue. Issue may not contain duplicate sub-issues and Sub issue may only have one parent',
        });
      }
    } else if (linked.includes(other.number)) {
      return json(422, {
        message:
          'An error occurred while adding the blocking issue to the issue. Validation failed: Target issue has already been taken',
      });
    }
    linked.push(other.number);
    return json(201, asIssue(found));
  };

  const onIssue = (method: string, repo: string, rest: string, body: unknown): Response => {
    const [, linkedTo, link] =
      /^issues\/(\d+)\/(sub_issues|dependencies\/blocked_by)$/.exec(rest) ?? [];
    if (linkedTo !== undefined) {
      const found = issue(repo, Number(linkedTo));
      if (found === undefined) return notFound();
      const what = link === 'sub_issues' ? 'sub_issues' : 'blocked_by';
      return onLinks(method, repo, found, what, body);
    }
    const [, number, what = '', label] =
      /^issues\/(\d+)(?:\/(assignees|labels|comments|events)(?:\/(.+))?)?$/.exec(rest) ?? [];
    const found = issue(repo, Number(number));
    // A pull request is an issue to GitHub's comments, as to its numbers.
    const pull = pulls.some(
      (each) => each.repo === repo.toLowerCase() && each.number === Number(number),
    );
    // And to its issue read, which gives a pull request's title (ADR 0225).
    const asIssueOfPull = pulls.find(
      (each) => each.repo === repo.toLowerCase() && each.number === Number(number),
    );
    if (found === undefined && asIssueOfPull !== undefined && method === 'GET' && what === '') {
      return json(200, {
        number: asIssueOfPull.number,
        state: asIssueOfPull.merged === undefined ? 'open' : 'closed',
        user: { login: asIssueOfPull.author },
        labels: [],
        title: asIssueOfPull.title,
        pull_request: {},
      });
    }
    if (found === undefined && !(pull && what === 'comments')) return notFound();
    const key = `${repo.toLowerCase()}#${Number(number)}`;
    const fieldsOf = (body ?? {}) as { body?: string };
    if (method === 'GET' && what === 'comments') {
      return json(200, (comments.get(key) ?? []).map(asComment));
    }
    if (method === 'POST' && what === 'comments') {
      const made = { id: ++ids, author: login, body: fieldsOf.body ?? '' };
      comments.set(key, [...(comments.get(key) ?? []), made]);
      return json(201, asComment(made));
    }
    if (found === undefined) return notFound();
    const fields = (body ?? {}) as {
      assignees?: string[];
      labels?: string[];
      body?: string;
      state?: 'open' | 'closed';
    };
    if (method === 'GET' && what === '') return json(200, asIssue(found));
    if (method === 'GET' && what === 'events') {
      // Each label added by whoever opened the issue (ADR 0359).
      const actor = { login: found.author };
      const events = found.labels.map((name, index) => ({
        id: index + 1,
        event: 'labeled',
        actor,
        label: { name },
      }));
      return json(200, events);
    }
    if (method === 'PATCH' && what === '') {
      if (fields.state !== undefined) found.state = fields.state;
      return json(200, asIssue(found));
    }
    if (method === 'POST' && what === 'assignees') {
      found.assignees = [...(found.assignees ?? []), ...(fields.assignees ?? [])];
      return json(201, asIssue(found));
    }
    if (method === 'POST' && what === 'labels') {
      found.labels = [...found.labels, ...(fields.labels ?? [])];
      return json(200, labelsOf(found));
    }
    if (method === 'DELETE' && what === 'labels' && label !== undefined) {
      const name = decodeURIComponent(label);
      if (!found.labels.includes(name)) return json(404, { message: 'Label does not exist' });
      found.labels = found.labels.filter((each) => each !== name);
      return json(200, labelsOf(found));
    }
    return notFound();
  };

  // A comment of the repository by its id: read, or its body replaced.
  const onComment = (method: string, repo: string, id: number, body: unknown): Response => {
    const prefix = `${repo.toLowerCase()}#`;
    const found = [...comments.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .flatMap(([, list]) => list)
      .find((comment) => comment.id === id);
    if (found === undefined) return notFound();
    if (method === 'PATCH') found.body = (body as { body?: string }).body ?? '';
    else if (method !== 'GET') return notFound();
    return json(200, asComment(found));
  };

  const pulls: FakeApiPull[] = [];
  const asPull = (pull: FakeApiPull) => ({
    number: pull.number,
    html_url: `https://github.com/${pull.repo}/pull/${pull.number}`,
    user: { login: pull.author },
    head: { ref: pull.head, repo: { full_name: pull.repo } },
  });
  // The pull requests of a repository: listed by head (`owner:branch`), opened, and read by number,
  // each open on its head with no check run or commit status on it, as a fresh one is on GitHub.
  const onPulls = (method: string, repo: string, url: URL, body: unknown): Response => {
    const ofRepo = pulls.filter((pull) => pull.repo === repo.toLowerCase());
    const [, number] = /\/pulls\/(\d+)$/.exec(url.pathname) ?? [];
    if (number !== undefined) {
      const found = ofRepo.find((pull) => pull.number === Number(number));
      if (found === undefined) return notFound();
      // Its body revised, as the sibling sections of an order's pull requests are (ADR 0292).
      const revised = (body ?? {}) as { body?: string };
      if (method === 'PATCH' && revised.body !== undefined) found.body = revised.body;
      else if (method !== 'GET') return notFound();
      const { merged } = found;
      return json(200, {
        ...asPull(found),
        state: merged === undefined ? 'open' : 'closed',
        merged: merged !== undefined,
        merged_at: merged?.at ?? null,
        merge_commit_sha: merged?.sha ?? null,
        body: found.body,
        draft: found.draft === true,
        node_id: pullNode(found),
        head: { ref: found.head, sha: headOf(found.number), repo: { full_name: found.repo } },
      });
    }
    // Only the open ones, as GitHub lists them unless asked for every state; a merged one is closed.
    const open = ofRepo.filter((pull) => pull.merged === undefined);
    if (method === 'GET') {
      const head = url.searchParams.get('head')?.split(':').slice(1).join(':');
      const listed = url.searchParams.get('state') === 'all' ? ofRepo : open;
      return json(
        200,
        listed.filter((pull) => head === undefined || pull.head === head).map(asPull),
      );
    }
    const fields = body as Omit<FakeApiPull, 'repo' | 'number' | 'author'>;
    if (open.some((pull) => pull.head === fields.head)) {
      return json(422, { message: 'A pull request already exists' });
    }
    const pull = { repo: repo.toLowerCase(), number: ++ids, author: login, ...fields };
    pulls.push(pull);
    return json(201, asPull(pull));
  };

  // The check runs and commit statuses on the head of a pull request the fake opened: none.
  const onCommit = (method: string, repo: string, rest: string): Response => {
    const [, sha, what] = /^commits\/([0-9a-f]{40})\/(check-runs|status)$/.exec(rest) ?? [];
    const headed = pulls.some(
      (pull) => pull.repo === repo.toLowerCase() && headOf(pull.number) === sha,
    );
    if (method !== 'GET' || !headed) return notFound();
    return what === 'check-runs'
      ? json(200, { total_count: 0, check_runs: [] })
      : json(200, { state: 'pending', total_count: 0, statuses: [] });
  };

  const onGit = (method: string, repo: string, rest: string, body: unknown): Response => {
    if (method === 'POST' && rest === 'git/commits') {
      const sha = String(++commits).padStart(40, '0');
      messages.set(sha, (body as { message: string }).message);
      return json(201, { sha });
    }
    if (method === 'POST' && rest === 'git/refs') {
      const { ref, sha } = body as { ref: string; sha: string };
      if (refs.has(`${repo} ${ref}`)) return json(422, { message: 'Reference already exists' });
      refs.set(`${repo} ${ref}`, sha);
      created.push(`${repo} ${ref}`);
      return json(201, { ref, object: { type: 'commit', sha } });
    }
    if (method === 'GET' && rest.startsWith('git/ref/')) {
      const ref = `refs/${rest.slice('git/ref/'.length)}`;
      const sha = refs.get(`${repo} ${ref}`);
      return sha === undefined ? notFound() : json(200, { ref, object: { type: 'commit', sha } });
    }
    if (method === 'GET' && rest.startsWith('git/commits/')) {
      const sha = rest.slice('git/commits/'.length);
      // A merge commit, as git's data API gives it, with its date (ADR 0223).
      const merge = pulls.find(
        (pull) => pull.repo === repo.toLowerCase() && pull.merged?.sha === sha,
      );
      if (merge?.merged !== undefined) {
        const message = `Merge pull request #${merge.number}`;
        return json(200, { sha, message, committer: { date: merge.merged.at } });
      }
      const message = messages.get(sha);
      return message === undefined ? notFound() : json(200, { sha, message });
    }
    return notFound();
  };

  // A repository's latest published release, and how one of its commits stands to a release's tag:
  // its own commit, a merge made before it, or any other, which the tag does not hold.
  const onRelease = (method: string, repo: string, rest: string): Response => {
    if (method !== 'GET') return notFound();
    if (rest === 'releases/latest') {
      const latest = newest(releasesOf(repo).filter((each) => each.tagOnly !== true));
      if (latest === undefined) return notFound();
      return json(200, {
        tag_name: latest.tag,
        html_url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(latest.tag)}`,
        body: latest.notes ?? null,
        published_at: latest.at,
      });
    }
    const [, base = '', head] = /^compare\/(.+)\.\.\.([0-9a-f]{40})$/.exec(rest) ?? [];
    const tagged = releasesOf(repo).find((each) => each.tag === decodeURIComponent(base));
    if (tagged === undefined || head === undefined) return notFound();
    const status =
      head === tagged.commit ? 'identical' : tagged.held.includes(head) ? 'behind' : 'ahead';
    return json(200, { status });
  };

  const answer = (method: string, url: URL, body: unknown): Response => {
    const path = url.pathname;
    if (method === 'GET' && path === '/user') return json(200, { login });
    if (method === 'POST' && path === '/graphql') return graphql(body);
    // A repository itself: who can read it (ADR 0300).
    const [, whole] = /^\/repos\/([^/]+\/[^/]+)$/.exec(path) ?? [];
    if (whole !== undefined) {
      const visibility = options.visibilities?.[whole.toLowerCase()];
      if (method !== 'GET' || visibility === undefined) return notFound();
      return json(200, { full_name: whole, private: visibility === 'private', visibility });
    }
    const [, repo = '', rest = ''] = /^\/repos\/([^/]+\/[^/]+)\/(.*)$/.exec(path) ?? [];
    if (method === 'GET' && rest === 'issues') {
      const wanted = url.searchParams.get('labels')?.split(',') ?? [];
      const all = url.searchParams.get('state') === 'all';
      const creator = url.searchParams.get('creator');
      const listed = repoIssues(repo).filter(
        (each) =>
          (all || (each.state ?? 'open') === 'open') &&
          (creator === null || each.author === creator) &&
          wanted.every((label) => each.labels.includes(label)),
      );
      return json(200, listed.map(asIssue));
    }
    if (method === 'POST' && rest === 'issues') {
      const fields = body as { title?: string; body?: string; labels?: string[] };
      return json(201, asIssue(openIssue(repo, fields)));
    }
    const [, id] = /^issues\/comments\/(\d+)$/.exec(rest) ?? [];
    if (id !== undefined) return onComment(method, repo, Number(id), body);
    if (rest.startsWith('issues/')) return onIssue(method, repo, rest, body);
    if (rest.startsWith('git/')) return onGit(method, repo, rest, body);
    if (/^pulls(?:\/\d+)?$/.test(rest)) return onPulls(method, repo, url, body);
    if (rest.startsWith('commits/')) return onCommit(method, repo, rest);
    if (rest === 'releases/latest' || rest.startsWith('compare/')) {
      return onRelease(method, repo, rest);
    }
    if (method === 'POST' && rest === 'labels') {
      const { name } = body as { name: string };
      const made = labels.get(repo.toLowerCase()) ?? new Set();
      labels.set(repo.toLowerCase(), made);
      if (made.has(name)) {
        return json(422, { message: 'Validation Failed', errors: [{ code: 'already_exists' }] });
      }
      made.add(name);
      return json(201, { name });
    }
    return notFound();
  };

  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    requests.push(`${method} ${url.pathname}${url.search}`);
    const instead = options.instead?.(method, url);
    if (instead === 'hang') {
      return new Promise<Response>((_, reject) => {
        if (init.signal?.aborted === true) reject(init.signal.reason);
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }
    if (instead !== undefined) return json(instead.status, instead.body, instead.headers);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    return answer(method, url, body);
  };
  return {
    fetch: fetch as typeof globalThis.fetch,
    requests,
    refs,
    created,
    pulls,
    comments,
    labels,
    issue,
    issues: options.issues,
    merge: (repo, number, merged) => {
      const pull = pulls.find((each) => each.repo === repo.toLowerCase() && each.number === number);
      if (pull === undefined) throw new Error(`The fake opened no pull request ${repo}#${number}`);
      pull.merged = { ...merged };
    },
    release: (repo, release) => {
      const key = repo.toLowerCase();
      const held = pulls.flatMap((pull) =>
        pull.repo === key && pull.merged !== undefined ? [pull.merged.sha] : [],
      );
      releases.set(key, [...releasesOf(key), { ...release, held }]);
    },
  };
};
