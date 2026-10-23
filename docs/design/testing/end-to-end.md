# End-to-end tests

**Contract tests** against a real GitHub test repository (opt-in, CI only).

**End-to-end tests** (from M1): a labelled issue in a throwaway Brewery becomes a pull request through serve's own `runServe` with Nip from `defaults/` (`test/integration/nip.test.ts`, in `npm run test:integration` on every CI leg). git, the attempt worktrees, the target's own test command in the check steps, the red proof, the guard, the route input and the push are real; GitHub is the fake code host behind the fake gh, and the brewers are a scripted Gauger, Cellarman and Taster (`test/helpers/nip-fixture.ts`), so the run is deterministic and needs no login or model.
The same run with the real `claude` against the fake Messages API is opt-in with `FOEDRUM_REAL_CLAUDE=1`, never in CI ([ADR 0121](../../adr/0121-the-m1-end-to-end-test-runs-nip-through-serve-with-real-git-and-checks-and-faked-github-and-brewers.md)).

**Browser end-to-end tests** (from M6, when the dashboard exists): Playwright Test as a development dependency, subject to the admission checklist; browsers are downloaded by an explicit command, not an install script.
