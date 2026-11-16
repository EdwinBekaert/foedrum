# 0408. A setup whose bwrap loses its loopback race runs once more

Date: 2026-11-16 · Status: Accepted · Amends [0218](0218-a-linux-setup-gets-a-network-namespace-of-its-own-through-a-user-mode-network-stack.md) (a setup that bwrap fails is unstarted)

## Context
On CI's ubuntu leg, a test of a setup in the real sandbox failed now and then with `bwrap: loopback: Failed RTM_NEWADDR: No child processes` (#1090).
In the last 100 CI runs and the 32 nightlies before 2026-11-16, it failed 2 of 128 ubuntu `check` jobs, and once more on 2026-11-02, each time in a test of "a setup in the real sandbox, the network kept", never in a test of a check.
With about 8 such setups per job, that is about one in 500 setups; an estimate, not a count of bwrap's starts.

The words are not the cause.
bubblewrap's `network.c` reads a netlink error reply and returns -1 without setting `errno`, and `die_with_error` then prints whatever `errno` held last; nothing in that file sets `ECHILD`.
bubblewrap #745 reads it the same way under gVisor, where the error is `EEXIST` because lo already has 127.0.0.1.

The cause is inferred, not proven with strace on a runner.
bwrap's parent writes the child's pid on `--info-fd` and then releases the child, which adds 127.0.0.1/8 to lo with `NLM_F_EXCL`; `--block-fd` is read only after that.
Foedrum starts the stack as soon as it reads the pid (ADR 0218), and both bring lo up in the namespace: pasta always, slirp4netns with `--configure`.
Bringing lo up gives it 127.0.0.1/8, so when the stack is first, bwrap's exclusive add fails with `EEXIST`, and bwrap ends before the line runs.
A check has no stack in its namespace, so it never races.

A real Brewery's setup on Linux meets the same race: ADR 0218 reads the run as unstarted, and the batch is Stuck on its environment, with "No child processes" as the reason.

## Decision
- A setup whose bwrap run is unstarted with words that start `bwrap: loopback: Failed RTM_NEWADDR` runs once more: the line did not run, and the namespace and its stack ended with bwrap.
- The second run gets only the time the first run left of the setup's timeout, so the setup's deadline of ADR 0140 and ADR 0163 holds for both runs together.
- A second such failure is unstarted with bwrap's words, `twice`, and the likely race in plain words, citing this record.
- Nothing else is run again: another bwrap failure, a stack's, and a line that ran and passed, was killed or ended on a signal, whatever it printed.
- This stands in for the upstream fix, bubblewrap PR #821, which accepts a lo that is already up with 127.0.0.1/8, until the bwrap of the hosts Foedrum runs on has it.

## Consequences
- A setup that loses the race costs one more start of bwrap and the stack; two in a row is about one in 250,000 setups, if the estimate holds.
- A line that ran, wrote bwrap's loopback words first on stderr and exited non-zero already reads as bwrap's own failure (ADR 0076), so it now runs once more: the repository's own code gets one more run in the same sandbox, within the time its first run left, and nothing else.
- `--userns-block-fd` would not help: it holds the child until the stack is up, which makes the stack win the race every time.
- No Brewery's files change.
