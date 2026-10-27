export const meta = {
  name: 'brew-audit',
  description: 'Read-only audit of Foedrum at a pinned commit: security, architecture, over-engineering, complexity, smells, AI slop, tests and the ADRs',
  whenToUse: 'Run by the /brew-audit skill; finding nothing is a valid result',
  phases: [
    { title: 'Find', detail: 'one auditor per area, plus tests and ADRs' },
    { title: 'Verify', detail: 'one skeptic per area tries to refute each finding' },
    { title: 'Report', detail: 'one ranked report' },
  ],
}

// args: { root: absolute path of a checkout pinned at sha, read-only;
//         sha: the full commit; repo: "owner/name" for the links;
//         since?: full commit of the previous audit; previous?: that audit's findings (array) }
const ROOT = args.root
const SHA = args.sha
const LINK = `https://github.com/${args.repo}/blob/${SHA}/`
const SINCE = args.since
const PREVIOUS = args.previous ?? []

const STANCE = `Finding nothing is a good result. You are not judged by how many findings you report. An area that is clean gets the verdict "nothing worth changing", and that is as useful as a finding. Report only what you would defend to the maintainer: a concrete file and line, what is wrong, why it matters (a real risk, a real cost to read or change it), and what to do instead. Leave out taste, style that the lint already rules, "could be more generic", and anything you would only call "consider". If you are unsure whether something is a problem, it is not a finding: leave it out. A short report with two real findings beats a long one with twenty.`

const DIMENSIONS = `Look for, in this order of weight:
1. security: injection into shell or git arguments, secrets reaching text that leaves the machine (GitHub comments, pull request bodies, logs), path traversal in worktrees and file writes, untrusted model output or GitHub text reaching a prompt, a command or GitHub without the filters the design requires, escape routes around the push gate or the sandbox. Use docs/trust-boundaries.md and defaults/lenses/diff/security.md as the checklist.
2. bad architecture: a layer that leaks into another (engine importing cli, a pure fold or decide doing I/O, platform code knowing about recipes), circular imports, one concept spread over many files with no owner, the same decision made in two places that can disagree. Use defaults/lenses/diff/design-conformance.md, docs/architecture.md and CLAUDE.md.
3. over-engineering: options, parameters, layers or generality that nothing uses or that serve one caller; machinery larger than the problem. Use defaults/lenses/diff/necessity.md as the checklist (read it as "code the codebase does not need").
4. over-complication: functions far longer than their job, deep nesting, state stored that could be derived, control flow that is hard to follow for what it does.
5. code smells: duplicated helpers or near-duplicate functions, dead exports, misleading names, a type that lies about what it holds.
6. AI slop: comments that restate the code or narrate history, defensive checks for things the types or callers already rule out, near-duplicate functions written twice instead of reused, wordy error text, long explanations where a name would do.
Correctness bugs you notice on the way count too (defaults/lenses/diff/correctness.md), and Windows, macOS and Linux differences (defaults/lenses/diff/cross-platform.md).`

const RULES = `Work read-only in the pinned checkout ${ROOT} (commit ${SHA}). Never edit, create or delete a file there, never run git commands that change anything, never run npm install or the test suite. Reading, grep and glob are fine. Read docs/glossary.md, docs/architecture.md and docs/brewers-and-recipes.md before judging, and the ADRs in docs/adr/ that the code you read cites (a design choice an ADR made deliberately is not a finding for you; if you think the ADR itself is wrong, say so in one line under adrDoubts). Cite each finding with its path relative to the repository root and a line number at this commit. Never write a person's name; say "the maintainer".`

const sinceNote = (area) => {
  if (!SINCE) return ''
  const mine = PREVIOUS.filter((f) => f.area === area)
  return `

This audit follows an earlier one at ${SINCE}. Run \`git -C ${ROOT} diff --name-only ${SINCE} ${SHA}\` and audit the files of your area that changed since then, with what they touch. Code that did not change was audited then: leave it unless a change made it worse.
Then re-check each earlier finding of your area at this commit and put each in "previous" as fixed (the problem is gone), open (still there; give the line at this commit) or gone (the code it named no longer exists).
Earlier findings of this area:
${JSON.stringify(mine.map((f) => ({ id: f.id, file: f.file, line: f.line, title: f.title })), null, 1)}`
}

const FINDINGS = {
  type: 'object',
  properties: {
    area: { type: 'string' },
    verdict: { type: 'string', description: 'two or three sentences: the state of this area overall; "nothing worth changing" is allowed' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'short id, area-prefixed, e.g. engine-core-1' },
          dimension: { type: 'string', enum: ['security', 'architecture', 'over-engineering', 'over-complication', 'smell', 'ai-slop', 'correctness', 'cross-platform', 'adr', 'tests'] },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          title: { type: 'string' },
          what: { type: 'string' },
          why: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['id', 'dimension', 'severity', 'file', 'line', 'title', 'what', 'why', 'fix'],
      },
    },
    previous: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, state: { type: 'string', enum: ['fixed', 'open', 'gone'] }, line: { type: 'integer' }, note: { type: 'string' } },
        required: ['id', 'state'],
      },
    },
    adrDoubts: { type: 'array', items: { type: 'string' } },
  },
  required: ['area', 'verdict', 'findings'],
}

const VERDICTS = {
  type: 'object',
  properties: {
    area: { type: 'string' },
    verdict: { type: 'string' },
    kept: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, severity: { type: 'string', enum: ['high', 'medium', 'low'] }, note: { type: 'string' } },
        required: ['id', 'severity', 'note'],
      },
    },
    dropped: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id', 'reason'] },
    },
  },
  required: ['area', 'verdict', 'kept', 'dropped'],
}

const AREAS = [
  { key: 'engine-core', scope: 'src/engine/: the core loop and state. decide.ts, fold.ts, admit.ts, supervisor*.ts, driver.ts, event-store.ts, ready-set.ts, the command log and ledger, leases, lens-rounds.ts, recipes.ts, recipe-files.ts, and any engine file not listed under engine-github.' },
  { key: 'engine-github', scope: 'src/engine/: everything that writes to GitHub or reads it back. pull-request*.ts, merge-brief*.ts, status-comment.ts, plan-comment.ts, base-check.ts, base-merge.ts, merged-checks.ts, pr-checks.ts, intake.ts, claim*.ts, lane labels, out-doc-text.ts.' },
  { key: 'brewers-checks', scope: 'src/brewers/ and src/checks/: the claude runner, the interactive runner, attempt plans and route inputs, prompt building, settle and scan, gravity readings and the check sandbox.' },
  { key: 'cli', scope: 'src/cli/: every command, serve, brew, resume, doctor, init, driver-wiring.ts, status and lens reports.' },
  { key: 'io-boundary', scope: 'src/github/, src/workspace/, src/platform/, src/formats/: the gh client, git worktrees and merges, processes and the sandbox, secret detection. Weigh security first here.' },
  { key: 'schemas', scope: 'src/schemas/ and schemas/*.json: zod schemas, events, out docs, config. Look for schemas that accept more than the code handles, duplicated shapes, and fields nothing reads.' },
  { key: 'tooling', scope: 'scripts/ (the push gate precheck.ts and its denylist, check.ts, affected-tests, the budget reporter, the review tools), .claude/settings.json, .claude/rules/, .claude/workflows/, plugin/ and .claude/skills/. Weigh the push gate as a security boundary.' },
]

const finderPrompt = (a) => `You audit one area of Foedrum, an orchestrator that runs Claude agents on GitHub issues and delivers pull requests.

Area "${a.key}": ${a.scope}
Any directory under src/ that no area names is yours if it is closest to your scope; say so in your verdict.

${RULES}

${DIMENSIONS}

${STANCE}${sinceNote(a.key)}`

const testsPrompt = `You audit the tests of Foedrum: test/unit, test/property, test/chaos, test/integration and test/helpers. Sample: the 15 largest test files, the helpers, and three test files of your choosing per layer. Judge test bloat and AI slop in tests: many tests asserting the same thing with small variations where one table would do, tests that pin implementation details instead of behaviour, fakes that re-implement the code they stand in for, setup duplicated across files, slow tests (real git, real time, wall-clock waits, large loops) where a pure test would do, tests nobody could tell apart by name. Use defaults/lenses/diff/test-design.md as the checklist. Use dimension "tests" for these, and the other dimensions for anything else.

${RULES}

${STANCE}${sinceNote('tests')}`

const adrPrompt = `You audit the decisions themselves: the records in docs/adr/ of Foedrum. Read docs/adr/README.md (the index) first, then every ADR whose title suggests a mechanism, a guard, a check or a limit, and any you need to judge them. Look for:
- decisions over-built for the problem they solve (a mechanism, guard or schema larger than the failure it prevents, especially one with no observed failure behind it);
- ADRs that contradict each other, or a later ADR that silently overrides an earlier one without saying "amends" or "supersedes";
- decisions the code no longer follows (check the code quickly), or follows in a way the ADR did not mean;
- guards, checks or rules that cost every run time or tokens and protect against something unlikely;
- decisions that would hurt someone using Foedrum on their own repository.
Use dimension "adr" and cite the ADR file (line 1 is fine) or the code line.${SINCE ? `

This audit follows an earlier one at ${SINCE}: judge the ADRs added or changed since then (\`git -C ${ROOT} diff --name-only ${SINCE} ${SHA} -- docs/adr\`), and the older ones only where a new one touches them.` : ''}

${RULES}

${STANCE}${sinceNote('adrs')}`

const verifyPrompt = (r) => `You are a skeptic. Another auditor reported these findings on area "${r.area}" of Foedrum. Try to refute each one by reading the code yourself in ${ROOT} (commit ${SHA}), read-only.

Drop a finding when it is speculative, when the code already handles the case (check callers, schemas and tests), when the "fix" would add more than it removes, when the cited line does not show what is claimed, or when a design doc or ADR deliberately chose it (an ADR doubt is not a code finding). Keeping a weak finding is worse than dropping a real one. Re-rate the severity of what you keep: high means a real security risk or a defect that will bite; medium means a real cost to read or change the code; low means worth fixing when someone is in that file anyway.

The auditor's verdict on the area: ${r.verdict}

Findings:
${JSON.stringify(r.findings, null, 1)}

Give your own one- or two-sentence verdict on the area after checking, and for every finding either keep it (with what you checked) or drop it (with why).`

const reportPrompt = (results) => `Write the audit report of Foedrum at commit ${SHA}, in Markdown, from the verified results below. Only kept findings go in it; give how many were dropped per area in one line, without listing them.

Structure:
# Foedrum audit at ${SHA.slice(0, 8)}${SINCE ? ` (since ${SINCE.slice(0, 8)})` : ''}
- one paragraph: the overall state in plain words, and the three things most worth doing.
${SINCE ? '## Since the last audit\nA table of the earlier findings: id, title, fixed / open / gone, with the line at this commit for open ones.\n' : ''}## The findings, worst first
A table: severity | area | dimension | finding (one line) | link. Link each as [path:line](${LINK}<path>#L<line>).
## Per area
For each area: its verdict, then each kept finding: title, what, why, fix, severity, the verifier's note. An area with no kept finding says "nothing worth changing".
## The decisions (ADRs)
The kept ADR findings, then the adrDoubts the code auditors raised, deduplicated, one line each.
## What this audit did not cover
What was sampled rather than read, and what a person should still judge.

Rules: never write a person's name ("the maintainer"); no local path, only repository paths and the links above; no dollar amounts. Plain, short sentences. Do not add findings of your own.

Results:
${JSON.stringify(results, null, 1)}`

phase('Find')
const finders = [
  ...AREAS.map((a) => ({ key: a.key, prompt: finderPrompt(a) })),
  { key: 'tests', prompt: testsPrompt },
  { key: 'adrs', prompt: adrPrompt },
]

const verified = await pipeline(
  finders,
  (f) => agent(f.prompt, { label: `find:${f.key}`, phase: 'Find', schema: FINDINGS }),
  async (r, f) => {
    if (!r) return null
    const base = { area: f.key, adrDoubts: r.adrDoubts ?? [], previous: r.previous ?? [] }
    if (!r.findings.length) {
      log(`${f.key}: nothing to verify`)
      return { ...base, verdict: r.verdict, kept: [], dropped: [] }
    }
    const v = await agent(verifyPrompt({ ...r, area: f.key }), { label: `verify:${f.key}`, phase: 'Verify', schema: VERDICTS })
    if (!v) {
      log(`${f.key}: the verifier returned nothing; its findings are left out`)
      return { ...base, verdict: r.verdict, kept: [], dropped: [], unverified: r.findings.length }
    }
    const byId = new Map(r.findings.map((x) => [x.id, x]))
    const kept = v.kept.filter((k) => byId.has(k.id)).map((k) => ({ ...byId.get(k.id), area: f.key, severity: k.severity, verifierNote: k.note }))
    log(`${f.key}: ${kept.length} kept, ${v.dropped.length} dropped`)
    return { ...base, verdict: v.verdict, auditorVerdict: r.verdict, kept, dropped: v.dropped }
  },
)

const results = verified.filter(Boolean)
const missing = finders.map((f) => f.key).filter((k) => !results.some((r) => r.area === k))
if (missing.length) log(`no result for: ${missing.join(', ')}`)

phase('Report')
const report = await agent(reportPrompt(results), { label: 'report', phase: 'Report' })
return { sha: SHA, since: SINCE ?? null, report, findings: results.flatMap((r) => r.kept), results, missing }
