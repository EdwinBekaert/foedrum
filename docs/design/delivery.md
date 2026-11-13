# Delivery

Foedrum ships as an npm command-line program with a companion Claude Code plugin ([ADR 0016](../adr/0016-delivery-npm-cli-and-companion-plugin.md)):

| Part | What it is | How users get it |
|---|---|---|
| `foedrum` CLI | The engine (`foedrum serve`), `init`, `doctor`, `status`, `stuck`, `replay`, and the default brewers, recipes and lenses | `npm install --global foedrum` or `npx foedrum`, published with provenance from the second version on |
| Claude Code plugin | One skill, `/foedrum:<command>`, per command of the registry that is not terminal-only ([the plugin](humans/plugin.md)), in `plugin/`; Markdown only, each runs the CLI with `--via plugin` ([ADR 0125](../adr/0125-the-foedrum-plugin-is-markdown-skills-that-run-the-terminal-with-via-plugin.md)) | `claude plugin marketplace add EdwinBekaert/foedrum`, then `claude plugin install foedrum@foedrum --scope project`, in the Brewery's clone |
| Brewery | The user's control repository | `foedrum init` |
| Brewhouse (M6) | Dashboard served by the engine | `foedrum serve` prints its local address |

Run from a checkout, `foedrum init` offers a `foedrum` command in a user folder on the PATH that runs the checkout's `src/cli/main.ts` ([ADR 0210](../adr/0210-foedrum-init-writes-the-foedrum-command-into-a-user-folder-on-the-path.md)).
Run from the installed package, it writes none and, when no `foedrum` but npx's own is on the PATH, says to run `npm install --global foedrum` or `npx foedrum <command>` ([ADR 0390](../adr/0390-foedrum-init-offers-the-shim-only-from-a-checkout.md)).
Until `foedrum` is on the PATH, `/foedrum:init` runs a checkout's `src/cli/main.ts` that the engineer names ([ADR 0212](../adr/0212-foedrum-init-takes-every-answer-as-an-option-and-foedrum-init-asks-them-in-a-session.md)).

The package ships the JavaScript `tsc` emits from `src/` into `dist/` (`npm run build`, `tsconfig.build.json`), not the `.ts` files, since Node strips no types under `node_modules`; development runs the `.ts` files directly ([ADR 0377](../adr/0377-the-package-ships-the-javascript-tsc-emits-and-ci-starts-the-installed-tarball.md)).
Its `files` are `dist/`, `defaults/`, `schemas/` and the Job Object helper `src/platform/job-object.ps1`, which `tsc` does not copy; `bin` is `dist/cli/main.js`.
A module finds a file of the package from the package root, which lies as far above `dist/<area>/` as above `src/<area>/`: the defaults, `package.json` and the helper.
No lifecycle script builds it: CI runs `npm run build` before `npm pack`.
CI's `package` job builds, packs and installs the tarball into an empty folder outside the checkout on Linux, Windows and macOS for every pull request, then starts the installed `foedrum` (`--version`, `--help`, `doctor`), imports every emitted module and runs it once more through `npx` with the tarball as the package; `ci-ok` needs it.
The job is the reusable workflow `.github/workflows/package.yml`, which CI and the release both run ([ADR 0388](../adr/0388-a-tag-on-a-green-main-publishes-through-trusted-publishing-and-a-dry-run-proves-the-rest.md)).

## Releases

A tag `v<version>` pushed on a commit of `main` runs `.github/workflows/release.yml` ([ADR 0388](../adr/0388-a-tag-on-a-green-main-publishes-through-trusted-publishing-and-a-dry-run-proves-the-rest.md)):

1. `guard` checks that the tag is `v` and `package.json`'s `version`, that the commit is on `main`, and that CI's run of its push to `main` succeeded; it reads both through the GitHub API with the workflow's own token.
   Only a merge commit has such a run, so the tag goes on one.
2. `smoke` runs the package job on Linux, Windows and macOS.
3. `build` builds and packs the tarball in a fresh checkout, in a job without `id-token`, and hands it on as an artifact.
   `publish` runs only `npm publish` on that tarball, through trusted publishing: npm trades the job's OIDC token for a publish right, so no npm token is stored anywhere, and adds the provenance statement by itself.
   A prerelease version (`0.0.1-alpha.1`) goes to the dist-tag `next`, any other to `latest`.
   It runs only for a pushed tag, in the GitHub environment `npm`, whose deployment rule lets only `v*` tags in, and the trusted publisher names that environment: a branch that changes `release.yml` gets no token npm takes, whatever its file says.
   The environment has the maintainer as its required reviewer, so every publish waits for one approval on GitHub.
4. `release` creates the GitHub release for the tag with notes generated from the merged pull requests, marked as a prerelease for `next`.

Each job has only the permissions it needs: `publish` has `id-token: write` and `contents: read`, `release` `contents: write`, and no job that runs dependency code holds `id-token`.
The version changes in a pull request of its own, like any change to `package.json`.

The dry run is the same workflow run by hand (`gh workflow run release.yml`) or by a pull request that changes `release.yml` or `package.yml`: the guards print what they find as warnings, a job of its own, `publish-dry-run`, runs `npm publish --dry-run` on the same tarball outside the environment and without `id-token`, and no release is made.
It shows that the guards' API calls work, that the package installs and starts on the three platforms, and that npm takes the package.
It cannot show the OIDC exchange with npm, the environment's rule, the trusted publisher entry, the provenance badge or the release notes: only a real publish does.

### Before the first tag

npm adds a trusted publisher only to a package already on the registry, so the first version is created by the maintainer's own npm login, once, before the trusted publisher (#1022):

1. In the repository's settings, under Environments, create `npm` with a deployment rule that allows only tags matching `v*`, and the maintainer as its required reviewer.
2. Merge a pull request that sets `package.json`'s `version`, such as `0.0.1-alpha.1`, and wait for its CI on `main`.
3. Create the package on npm from that commit with the maintainer's login and 2FA: `npm run build`, then `npm stage publish --tag next`, then approve the staged version on npmjs.com.
   Staging a name that does not exist yet publishes a placeholder `0.0.0-stage` first; the version is public only once it is approved.
   This version carries no provenance.
4. On npmjs.com, in the package's settings, add a trusted publisher: GitHub Actions, organization or user `EdwinBekaert`, repository `foedrum`, workflow filename `release.yml` (the file name only), environment `npm`, and tick "allow npm publish".
   It must publish once within two days, or it is dropped.
5. Under Publishing access, choose "Require two-factor authentication and disallow tokens"; the trusted publisher keeps working.
6. Merge the next version (`0.0.1-alpha.2`), then tag its merge commit on `main` and push the tag: `git tag v0.0.1-alpha.2 <sha>` and `git push origin v0.0.1-alpha.2`.
7. When the run is green, check the provenance badge on the package's npm page and the `next` dist-tag (`npm view foedrum dist-tags`).

A `v*` tag on a commit outside `main` runs that commit's `release.yml`, so whoever may push such a tag may publish: the maintainer, and every Claude Code session on the maintainer's machine, which pushes with the same credentials; the required reviewer is what stops such a run: a session could approve it only through a `gh api` write, which the session's permission prompts ask about.

The engine runs in a terminal or as a service the user sets up (documented for systemd, launchd and Task Scheduler); it never depends on an open Claude Code session.
