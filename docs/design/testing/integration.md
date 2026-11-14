# Integration tests

Integration tests (`test/integration/`, `npm run test:integration`, CI and nightly) are a few per tool boundary, running the real git, npm or shell to prove the thin shells and the captured fixtures still match the real tools.
They test Foedrum's code against a tool, never whether the tool itself works; the real `gh` runs only against a local fake GitHub, never github.com ([ADR 0073](../../adr/0073-github-only-through-gh-s-own-login.md)), and the tests against the real `claude` run only with `FOEDRUM_REAL_CLAUDE=1` ([ADR 0057](../../adr/0057-real-claude-tests-are-opt-in-and-claude-proofs-leave-the-suite.md)).
CI's `real-claude` job sets it with a `claude` pinned in `ci/claude/`, on every leg: every such test in the nightly run, and on a pull request the ones its change reaches (`scripts/affected-tests.ts --real-claude`, [ADR 0399](../../adr/0399-ci-runs-the-tests-against-the-installed-claude-with-a-claude-pinned-in-a-lockfile-of-its-own.md)).
