---
paths:
  - "**/scripts/demo.ts"
  - "**/scripts/demo/**"
  - "**/test/**/demo*.test.ts"
  - "**/test/helpers/nip-fixture.ts"
---

# npm run demo

`npm run demo` makes a scratch Brewery and target repository with bare remotes in `.foedrum/tmp/demo/` (removed at the start of the next run), one order brewed with Nip from `defaults/` by the Nip fixture's scripted Gauger, Cellarman, Finer and Taster through `foedrum serve`'s own Cellar, killed mid-attempt with SIGKILL and started again, until the batch is on tap with one pull request and one status comment on an in-process fake code host; then a second order brewed by `foedrum brew` in a process of its own, and `foedrum resume`'s line for the Cellarman's attempt, printed and never opened.

- It walks through ten steps (the demo's own diagnosis, the order, `foedrum status` as the batch moves, the kill and the restart, the red proof and the failed check, the pull request and the status comment, on tap, `foedrum brew`, `foedrum resume`, `foedrum replay`), each with what to look for, and waits for Enter between them; `--no-pause`, or input that is not a terminal, goes straight through.
- Three seams are the demo's own (the brewer, the code host, the wait that ends a life); every git it starts reads only `<scratch>/gitconfig` (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM=1`): the demo's identity, no signing, and an `insteadOf` that sends `https://github.com/demo/web.git` to the scratch remote and every other GitHub URL to a path that does not exist, so serve's own push and fetches stay local.
- It imports the tests' fakes from `test/helpers/`, so it stays a script and the package ships only `src/`, `defaults/` and `schemas/` ([ADR 0097](../../docs/adr/0097-npm-run-demo-is-a-script-on-serve-s-seams-with-the-tests-fakes.md), [ADR 0139](../../docs/adr/0139-npm-run-demo-brews-with-nip-and-shows-foedrum-brew-and-foedrum-resume.md)).
