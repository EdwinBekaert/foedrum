// A local fake GitHub that the real gh reaches (ADR 0073), for the integration tests of the gh
// transport and of `foedrum serve`. gh takes a host, not a URL, and speaks https to every host but
// github.localhost, its development host, which it asks at http://api.github.localhost; with
// HTTP_PROXY pointing at the fake, those requests come here in absolute form. A synthetic login
// for github.localhost only is made in a GH_CONFIG_DIR of the test's own with --insecure-storage,
// so neither the OS keyring nor the user's gh login is touched, and nothing reaches github.com.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { withoutGitHubTokens } from '../../src/platform/env.ts';
import { execProcess } from '../../src/platform/processes.ts';
import { hangGuardMs } from '../helpers/load.ts';

export const FAKE_HOST = 'github.localhost';
/** The login the fake GitHub answers for, never a credential of any real account. */
export const SYNTHETIC_LOGIN = 'synthetic-login-for-a-local-fake';

export interface FakeRequest {
  method: string;
  /** The path and query, as the API sees them. */
  path: string;
  authorization: string | undefined;
  headers: IncomingMessage['headers'];
  body: string;
}

/** Answers a request the fake's own routes do not; `undefined` passes it on to them. */
export type Route = (
  request: FakeRequest,
  response: ServerResponse,
) => boolean | undefined | Promise<boolean | undefined>;

const PROXY_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY'];

/**
 * Starts the fake on 127.0.0.1 and logs gh in to it in `configDir`. `env` is the environment gh
 * runs in: this process's, without a token variable or a proxy of its own, with the fake as the
 * proxy and `configDir` as gh's configuration.
 */
export const startFakeGitHubOverGh = async (configDir: string, route: Route) => {
  const requests: FakeRequest[] = [];
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', async () => {
      // A request through a proxy names the whole URL.
      const url = new URL(incoming.url ?? '/', 'http://api.github.localhost');
      const request: FakeRequest = {
        method: incoming.method ?? 'GET',
        path: `${url.pathname}${url.search}`,
        authorization: incoming.headers.authorization,
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(request);
      if ((await route(request, response)) === true) return;
      // What gh auth login and gh auth status ask: the API root and the viewer's login.
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        request.path === '/graphql'
          ? JSON.stringify({ data: { viewer: { login: 'brewer' } } })
          : JSON.stringify({ current_user_url: 'http://api.github.localhost/user' }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const proxy = `http://127.0.0.1:${port}`;
  const upper = (name: string) => name.toUpperCase();
  const kept = Object.entries(withoutGitHubTokens(process.env, process.platform)).filter(
    ([name]) => !PROXY_NAMES.includes(upper(name)),
  );
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(kept),
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    GH_CONFIG_DIR: configDir,
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_PROMPT_DISABLED: '1',
  };
  const login = await execProcess(
    'gh',
    ['auth', 'login', '--hostname', FAKE_HOST, '--with-token', '--insecure-storage'],
    // The configuration is named in the call itself, as check-test-layers requires (ADR 0086).
    {
      cwd: configDir,
      env: { ...env, GH_CONFIG_DIR: configDir },
      stdin: SYNTHETIC_LOGIN,
      // Only a guard against a hang, never a limit on how long gh may take (ADR 0075).
      timeoutMs: hangGuardMs,
    },
  );
  if (login.exitCode !== 0) {
    server.close();
    throw new Error(`gh auth login to the fake failed: ${login.output}`);
  }
  requests.length = 0;
  return {
    env,
    requests,
    /** gh's environment with an empty configuration of its own: no login at all. */
    envWithoutLogin: (emptyDir: string): NodeJS.ProcessEnv => ({
      ...env,
      GH_CONFIG_DIR: join(emptyDir, 'gh'),
    }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};
