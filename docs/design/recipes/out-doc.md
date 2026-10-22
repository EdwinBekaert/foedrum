# The out doc contract

The only text Foedrum adds to every brewer prompt, besides the rule about tagged input when the brewer has inputs ([ADR 0041](../../adr/0041-untrusted-input-in-per-prompt-nonce-tags.md)):

```markdown
When you finish, write {outDoc}. It must start with JSON frontmatter: copy the example
below for how the run ended and fill it in, with only its keys and any your instructions
add. "questions" goes only with needs_input, "blockerKind" only with blocked.

The work is done:
---
{ "status": "done", "summary": "<one line>", "assumptions": ["<decided without asking>"] }
---

You need a human's answer to go on:
---
{ "status": "needs_input", "summary": "<one line>", "assumptions": ["<decided without asking>"],
  "questions": [{ "q": "...", "options": ["a", "b"], "recommended": "a", "whyBlocking": "..." }] }
---

Something stops the work. "blockerKind" is "findings" (problems to fix),
"environment" (a wall you cannot fix) or "divergence" (the plan does not match reality):
---
{ "status": "blocked", "summary": "<one line>", "assumptions": ["<decided without asking>"],
  "blockerKind": "findings" }
---

You could not finish:
---
{ "status": "failed", "summary": "<one line>", "assumptions": ["<decided without asking>"] }
---

Prefer deciding and recording an assumption over asking. Ask only when a wrong
guess would likely waste this run. Never ask questions any other way. Do not push.
```

For a brewer with `git.commit: true`, the last line ends before `Do not push.`, and two lines follow it ([ADR 0074](../../adr/0074-git-commit-grants-fixed-git-rules-and-done-needs-a-commit.md)):

```markdown
Commit your changes with git add and git commit before you write {outDoc}, and leave
{outDoc} out of every commit. Do not push.
```

For a brewer whose attempt allows shell commands, one line and a blank line come before `Prefer deciding …`, naming the commands of the plan's own `Bash` rules (its own, then those `git.commit` grants, then the repository's, once each, without the trailing star; not PowerShell rules, since the runner's sessions have no PowerShell tool), so a brewer whose command is denied does not read it as the whole shell denied (#222, [ADR 0085](../../adr/0085-the-out-doc-contract-names-the-attempts-shell-commands.md)).
For a committing brewer with no other shell rules:

```markdown
Your shell runs only: git status, git add, git commit. A denial stops that command only.
```

A plan with no Bash rules, or with one that allows any program (`Bash(*)`, a command that starts with a star), gets no such line.

One example per status, because the schema is strict: a brewer that copies the example for its status as it is writes a valid out doc, and one that fills in every key of a single template did not (#195).
The blocked example says `findings`, the one kind that can give the work another chance: another round inside a loop, else the step's `onBlocked` route, else Stuck (the table below), bounded by `maxRounds`.
The contract stays around 300 tokens (ADR 0005): a unit test holds it to 1,200 characters, and to 1,400 with the lines about committing and the commands they allow.
The list of commands grows with the brewer's and the repository's rules, so those limits hold the fixed text (ADR 0085).
Brewer-specific fields (for example a review verdict) are added by the brewer's own schema.

## How the engine routes an out doc

| Out doc | Next |
|---|---|
| `done` | Guards pass → next step |
| `needs_input` | Stuck 🔔 with the questions; the answer, from any surface, resumes the brewer's session as the next attempt when its `retryMode` is `resume`; otherwise, or when the session cannot be resumed, a fresh attempt gets every round's answers as its `answers` input ([ADR 0118](../../adr/0118-retrymode-resume-loads-and-an-answer-resumes-the-session-that-asked.md)) |
| `blocked` + `findings` | Next loop round, until `maxRounds`; outside a loop, the step's `onBlocked` route, else Stuck |
| `blocked` + `environment` | Stuck immediately: another round would hit the same wall |
| `blocked` + `divergence` | Stuck: the plan does not match reality |
| `failed` / missing / invalid | Retry per `maxAttempts`, then Stuck |
