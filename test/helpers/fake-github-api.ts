// A fake GitHub API behind a `fetch`, for `foedrum serve`'s tests (ADR 0068): the issues of each
// repository, its claim refs with their commits, and the marks of its issues, answered by method
// and path the way the GitHub layer asks (src/github/). No network (ADR 0021).

export interface FakeApiIssue {
  number: number;
  labels: string[];
  author: string;
  assignees?: string[];
  body?: string;
  title?: string;
  state?: 'open' | 'closed';
}

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
}

/** An answer to send instead of the fake's own; `hang` never answers until its signal aborts. */
export type Instead = { status: number; body?: unknown; headers?: Record<string, string> } | 'hang';

export interface FakeGitHubApiOptions {
  /** The login of the token. */
  login: string;
  /** The open issues of each repository, by `owner/name` in lower case. */
  issues: Record<string, FakeApiIssue[]>;
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
  readonly comments: Map<string, { id: number; author: string; body: string }[]>;
  /** The labels made in each repository, by `owner/name` in lower case. */
  readonly labels: Map<string, Set<string>>;
  issue(repo: string, number: number): FakeApiIssue | undefined;
  /** The issues of each repository, those opened through the API included (ADR 0144). */
  readonly issues: Record<string, FakeApiIssue[]>;
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
  const comments = new Map<string, { id: number; author: string; body: string }[]>();
  const labels = new Map<string, Set<string>>();
  let ids = 0;
  let commits = 0;
  const repoIssues = (repo: string): FakeApiIssue[] => options.issues[repo.toLowerCase()] ?? [];
  // An issue opened through the API, numbered after every issue and pull request of its repository.
  const openIssue = (repo: string, fields: { title?: string; body?: string }): FakeApiIssue => {
    const key = repo.toLowerCase();
    const listed = options.issues[key] ?? [];
    options.issues[key] = listed;
    const numbers = [
      ...listed.map((each) => each.number),
      ...pulls.filter((pull) => pull.repo === key).map((pull) => pull.number),
    ];
    const made: FakeApiIssue = {
      number: Math.max(0, ...numbers) + 1,
      labels: [],
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
    number: found.number,
    state: found.state ?? 'open',
    user: { login: found.author },
    labels: found.labels.map((name) => ({ name })),
    assignees: (found.assignees ?? []).map((assignee) => ({ login: assignee })),
    body: found.body ?? null,
    ...(found.title === undefined ? {} : { title: found.title }),
  });
  const labelsOf = (found: FakeApiIssue) => found.labels.map((name) => ({ name }));

  // The two GraphQL requests of the claim host: a repository's id, and a conditional delete.
  const graphql = (body: unknown): Response => {
    const { query, variables } = body as { query: string; variables: Record<string, unknown> };
    if (query.includes('repository(')) {
      return json(200, { data: { repository: { id: `R_${variables.owner}/${variables.name}` } } });
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

  const onIssue = (method: string, repo: string, rest: string, body: unknown): Response => {
    const [, number, what = '', label] =
      /^issues\/(\d+)(?:\/(assignees|labels|comments)(?:\/(.+))?)?$/.exec(rest) ?? [];
    const found = issue(repo, Number(number));
    if (found === undefined) return notFound();
    const key = `${repo.toLowerCase()}#${found.number}`;
    const fields = (body ?? {}) as {
      assignees?: string[];
      labels?: string[];
      body?: string;
      state?: 'open' | 'closed';
    };
    if (method === 'GET' && what === '') return json(200, asIssue(found));
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
    if (method === 'GET' && what === 'comments') {
      const listed = (comments.get(key) ?? []).map(({ id, author, body: text }) => ({
        id,
        user: { login: author },
        body: text,
      }));
      return json(200, listed);
    }
    if (method === 'POST' && what === 'comments') {
      const made = { id: ++ids, author: login, body: fields.body ?? '' };
      comments.set(key, [...(comments.get(key) ?? []), made]);
      return json(201, { id: made.id, user: { login }, body: made.body });
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
    return json(200, { id, user: { login: found.author }, body: found.body });
  };

  const pulls: FakeApiPull[] = [];
  const asPull = (pull: FakeApiPull) => ({
    number: pull.number,
    html_url: `https://github.com/${pull.repo}/pull/${pull.number}`,
    user: { login: pull.author },
    head: { ref: pull.head, repo: { full_name: pull.repo } },
  });
  // The pull requests of a repository: listed by head (`owner:branch`), and opened.
  const onPulls = (method: string, repo: string, url: URL, body: unknown): Response => {
    const ofRepo = pulls.filter((pull) => pull.repo === repo.toLowerCase());
    if (method === 'GET') {
      const head = url.searchParams.get('head')?.split(':').slice(1).join(':');
      return json(
        200,
        ofRepo.filter((pull) => head === undefined || pull.head === head).map(asPull),
      );
    }
    const fields = body as {
      head: string;
      base: string;
      title: string;
      body: string;
      draft?: boolean;
    };
    if (ofRepo.some((pull) => pull.head === fields.head)) {
      return json(422, { message: 'A pull request already exists' });
    }
    const pull = { repo: repo.toLowerCase(), number: ++ids, author: login, ...fields };
    pulls.push(pull);
    return json(201, asPull(pull));
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
      const message = messages.get(sha);
      return message === undefined ? notFound() : json(200, { sha, message });
    }
    return notFound();
  };

  const answer = (method: string, url: URL, body: unknown): Response => {
    const path = url.pathname;
    if (method === 'GET' && path === '/user') return json(200, { login });
    if (method === 'POST' && path === '/graphql') return graphql(body);
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
      return json(201, asIssue(openIssue(repo, body as { title?: string; body?: string })));
    }
    const [, id] = /^issues\/comments\/(\d+)$/.exec(rest) ?? [];
    if (id !== undefined) return onComment(method, repo, Number(id), body);
    if (rest.startsWith('issues/')) return onIssue(method, repo, rest, body);
    if (rest.startsWith('git/')) return onGit(method, repo, rest, body);
    if (rest === 'pulls') return onPulls(method, repo, url, body);
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
  };
};
