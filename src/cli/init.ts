// `foedrum init` (ADR 0199, ADR 0207): asks a few questions on the terminal, builds a Brewery's
// files from the answers and from what GitHub says of each target repository, checks each against
// its schema, and, outside a clone, creates the Brewery's repository and clones it. It writes the
// new files and asks before changing one that is there, offers the intake label in each target
// repository, commits and pushes after asking, then runs doctor. The ports are the terminal, the
// files, GitHub through gh, git and doctor; init-main.ts gives the real ones.

import { parseJsonc } from '../formats/jsonc.ts';
import { LABEL_COLOR } from '../github/brewery-repository.ts';
import type { RepositoryFacts } from '../github/repository-facts.ts';
import { BreweryConfig } from '../schemas/brewery-config.ts';
import { BreweryClaudeSettings } from '../schemas/brewery-settings.ts';
import { Repo } from '../schemas/events.ts';
import { RepositoryAlias } from '../schemas/ids.ts';
import { ModelsConfig } from '../schemas/models.ts';
import { CheckName, Command } from '../schemas/primitives.ts';
import { readJsonc } from '../schemas/read.ts';
import type { z } from '../schemas/zod.ts';
import { firstLine } from '../workspace/clone-git.ts';
import type { GitResult } from '../workspace/git.ts';
import type { CliResult } from './run.ts';

export interface InitPorts {
  /** Asks one question; `undefined` when standard input has ended. */
  ask: (question: string) => Promise<string | undefined>;
  /** Shows one line on the terminal, as it comes. */
  say: (line: string) => void;
  /** Files and folders, by their path from the working directory with `/`. */
  files: {
    exists: (path: string) => boolean;
    read: (path: string) => string | undefined;
    write: (path: string, text: string) => void;
  };
  /** The login gh uses (ADR 0073). */
  login: () => Promise<string>;
  /** What GitHub says of `repo`. */
  repository: (repo: string) => Promise<RepositoryFacts>;
  /** What init does on GitHub through gh's login (ADR 0207). */
  github: {
    exists: (repo: string) => Promise<boolean>;
    /** Creates `repo`, empty, under `login` when it is the owner, else under the organization. */
    create: (repo: string, login: string, isPrivate: boolean) => Promise<void>;
    hasLabel: (repo: string, label: string) => Promise<boolean>;
    createLabel: (repo: string, label: string, description: string) => Promise<void>;
  };
  /** git in `folder`, from the working directory (`''` for itself), as Foedrum runs it. */
  git: (folder: string, args: readonly string[]) => Promise<GitResult>;
  /** doctor's report on the clone in `folder`, and whether it found the machine ready. */
  doctor: (folder: string) => Promise<{ ok: boolean; report: string }>;
}

/** The plugin the Brewery's sessions enable, from this repository as its marketplace (ADR 0125). */
const PLUGIN = 'foedrum@foedrum';
const PLUGIN_COMMANDS = [
  'claude plugin marketplace add EdwinBekaert/foedrum',
  `claude plugin install ${PLUGIN} --scope project`,
];
/** The label the intake claims a target repository's issues by (ADR 0068). */
const INTAKE_LABEL = 'foedrum:brew';
const LABEL_DESCRIPTION = 'Foedrum brews an issue with this label into a pull request';
const COMMIT_MESSAGE = 'Set up the Brewery with foedrum init';
const PUSH = ['push', '-u', 'origin', 'HEAD'];
const IGNORED = '.foedrum/';
/** No aliases of its own: every alias is Foedrum's default (ADR 0153). */
const MODELS = `// Model aliases over Foedrum's defaults (ADR 0153), such as { "builder": "opus" }.
{ "models": {} }
`;

/** Standard input ended before an answer: init stops where it is. */
class NoAnswer extends Error {}

type Parsed<T> = { value: T } | { refused: string };

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The first message of a schema that refused `value`, or the value it parsed. */
const schemaOf =
  <T>(schema: z.ZodType<T>) =>
  (value: unknown): Parsed<T> => {
    const parsed = schema.safeParse(value);
    return parsed.success
      ? { value: parsed.data }
      : { refused: parsed.error.issues[0]?.message ?? 'Not valid' };
  };

/** A file as it is in the clone: not there, there but not a JSON(C) object, or its object. */
type Existing =
  | { kind: 'missing' }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'read'; value: Json };

const readObject = (text: string | undefined): Existing => {
  if (text === undefined) return { kind: 'missing' };
  try {
    const value = parseJsonc(text);
    return isRecord(value)
      ? { kind: 'read', value }
      : { kind: 'unreadable', reason: 'it is not an object' };
  } catch (error) {
    if (error instanceof SyntaxError) return { kind: 'unreadable', reason: error.message };
    throw error;
  }
};

/** The paths whose values differ between `was` and `now`, a key only one of them has by name. */
const changedPaths = (was: unknown, now: unknown, path: readonly string[] = []): string[] => {
  if (isRecord(was) && isRecord(now)) {
    return [...new Set([...Object.keys(was), ...Object.keys(now)])].flatMap((key) => {
      const at = [...path, key].join('.');
      if (!Object.hasOwn(now, key)) return [`${at} (removed)`];
      if (!Object.hasOwn(was, key)) return [`${at} (added)`];
      return changedPaths(was[key], now[key], [...path, key]);
    });
  }
  return JSON.stringify(was) === JSON.stringify(now) ? [] : [path.join('.')];
};

/** A file init would write: its text, and what it changes in the one there (none when new). */
interface Planned {
  path: string;
  text: string;
  /** `undefined` for a new file; the lines that say what changes, none when it is up to date. */
  changes: string[] | undefined;
  question?: string;
  /** A file init keeps as it is, without comparing it. */
  kept?: true;
}

/** A JSON object file: written new, or what it changes in the object there. */
const planObject = (path: string, existing: Existing, value: Json): Planned => {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  switch (existing.kind) {
    case 'missing':
      return { path, text, changes: undefined };
    case 'unreadable':
      return { path, text, changes: [`all of it: ${existing.reason}`] };
    case 'read':
      return { path, text, changes: changedPaths(existing.value, value) };
    default: {
      const never: never = existing;
      throw new Error(`Unknown file ${JSON.stringify(never)}`);
    }
  }
};

/** Checks `text` against `schema`; a file init built that does not pass is a bug in init. */
const passes = <T>(path: string, text: string, schema: z.ZodType<T>): void => {
  const read = readJsonc(text, schema);
  if (!read.valid) throw new Error(`${path} would not pass its schema: ${read.reason}`);
};

/** The five checks of a Node repository: its scripts by name, `npm test` for `test`. */
const nodeChecks = (scripts: Json): Record<CheckName, string | null> =>
  Object.fromEntries(
    CheckName.options.map((check) => [
      check,
      typeof scripts[check] !== 'string'
        ? null
        : check === 'test'
          ? 'npm test'
          : `npm run ${check}`,
    ]),
  ) as Record<CheckName, string | null>;

/**
 * The rules that let a brewer run a Node repository's checks, in the shapes the default Cellarman
 * runs them: each script, lint with `--write` on the files it changed, and one test file at a time
 * (ADR 0163, ADR 0199).
 */
const nodeTools = (checks: Record<string, string | null>): string[] =>
  CheckName.options.flatMap((check) => {
    if (checks[check] === null) return [];
    const script = `Bash(npm run ${check})`;
    if (check === 'lint') return [script, 'Bash(npm run lint -- --write *)'];
    if (check === 'test') return [script, 'Bash(node --test *)'];
    return [script];
  });

/**
 * A repository's `package.json` scripts; `undefined` when it has none that reads: not there, over
 * GitHub's 1 MB (`''`) or not a JSON object. A byte order mark is read past, as npm does.
 */
const scriptsOf = (packageJson: string | undefined): Json | undefined => {
  if (packageJson === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(packageJson.replace(/^\uFEFF/, ''));
    if (!isRecord(value)) return undefined;
    return isRecord(value.scripts) ? value.scripts : {};
  } catch {
    return undefined;
  }
};

/** The alias a repository's name suggests: its lower-case letters and digits, from a letter. */
const suggestedAlias = (repo: string): string =>
  (repo.split('/')[1] ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/^[0-9]+/, '')
    .slice(0, 20);

/** Runs `foedrum init` through `ports`. */
export const runInit = async (ports: InitPorts): Promise<CliResult> => {
  const { say, files } = ports;
  // Outside a clone, init creates the repository and clones it into a folder of its name (ADR 0207).
  const inClone = files.exists('.git');
  // The clone's folder from the working directory, `''` inside one; known once the name is asked.
  let folder = '';
  const at = (path: string): string => (folder === '' ? path : `${folder}/${path}`);

  // Asks until an answer passes `parse`, which says why it does not.
  const ask = async <T>(
    question: string,
    fallback: string | undefined,
    parse: (answer: string) => Parsed<T> | Promise<Parsed<T>>,
  ): Promise<T> => {
    const shown = `${question}${fallback ? ` [${fallback}]` : ''}: `;
    for (;;) {
      const answer = await ports.ask(shown);
      if (answer === undefined) throw new NoAnswer(question);
      const parsed = await parse(answer.trim() || (fallback ?? ''));
      if ('value' in parsed) return parsed.value;
      say(`  ${parsed.refused}`);
    }
  };

  // A yes or no, `byDefault` for an empty answer.
  const confirm = async (question: string, byDefault: boolean): Promise<boolean> => {
    const answer = await ports.ask(question);
    if (answer === undefined) throw new NoAnswer(question.replace(/ \[.*$/, ''));
    const given = answer.trim();
    return given === '' ? byDefault : /^y(?:es)?$/i.test(given);
  };

  // The files written or changed, said before doctor's report.
  const written: string[] = [];
  // Whether a git call of the commit and push failed, which ends init in 1.
  let pushFailed = false;
  // A foedrum.jsonc that reads but does not pass is the user's to fix, before any question.
  const config: Existing = inClone ? readObject(files.read('foedrum.jsonc')) : { kind: 'missing' };
  if (config.kind === 'read') {
    const checked = readJsonc(files.read('foedrum.jsonc') ?? '', BreweryConfig);
    if (!checked.valid) {
      const reason = checked.reason
        .split(/\r?\n/)
        .map((line) => line.trim())
        .join(' ');
      return refuse(`the foedrum.jsonc here does not pass its schema: ${reason}`);
    }
  }
  try {
    const login = await ports.login();
    const base: Json = config.kind === 'read' ? config.value : {};
    const named = Repo.safeParse(base.brewery);
    const brewery = await ask(
      'Brewery repository (owner/name)',
      named.success ? named.data : `${login}/foedrum-brewery`,
      schemaOf(Repo),
    );
    let isPrivate = true;
    if (!inClone) {
      // init creates a repository, never takes one over.
      if (await ports.github.exists(brewery)) {
        return refuse(
          `${brewery} is on GitHub already; run init in its clone (git clone https://github.com/${brewery}.git)`,
        );
      }
      const name = brewery.split('/')[1] ?? '';
      if (files.exists(name)) {
        return refuse(`the folder ${name} is there already; run init where it is not`);
      }
      folder = name;
      isPrivate = await ask('Private or public', 'private', (answer): Parsed<boolean> => {
        if (answer === 'private' || answer === 'public') return { value: answer === 'private' };
        return { refused: 'Answer private or public' };
      });
    }

    // The repositories foedrum.jsonc has keep their entries as they are.
    const kept: Json = isRecord(base.repositories) ? base.repositories : {};
    const facts = new Map<string, RepositoryFacts>();
    const targets = await ask(
      'Target repositories (owner/name, separated by spaces)',
      Object.keys(kept).join(' '),
      async (answer): Promise<Parsed<string[]>> => {
        const names = [...new Set(answer.split(/\s+/).filter((name) => name !== ''))];
        for (const name of names) {
          const checked = schemaOf(Repo)(name);
          if ('refused' in checked) return { refused: `${name}: ${checked.refused}` };
        }
        const lower = new Set(names.map((name) => name.toLowerCase()));
        if (lower.size !== names.length) return { refused: 'A repository is named twice' };
        for (const name of names.filter((name) => !Object.hasOwn(kept, name))) {
          if (facts.has(name)) continue;
          try {
            facts.set(name, await ports.repository(name));
          } catch (error) {
            return { refused: error instanceof Error ? error.message : String(error) };
          }
        }
        return { value: names };
      },
    );

    // The aliases of the repositories it keeps, which a new one may not take.
    const aliases = new Set(
      targets.flatMap((repo) => {
        const entry = Object.hasOwn(kept, repo) ? kept[repo] : undefined;
        return isRecord(entry) && typeof entry.alias === 'string' ? [entry.alias] : [];
      }),
    );
    const repositories: Json = {};
    const ceiling: string[] = Array.isArray(base.permissionCeiling)
      ? base.permissionCeiling.filter((rule): rule is string => typeof rule === 'string')
      : [];
    for (const repo of targets) {
      if (Object.hasOwn(kept, repo)) {
        repositories[repo] = kept[repo];
        continue;
      }
      // Read while the targets were asked.
      const read = facts.get(repo) as RepositoryFacts;
      const readScripts = scriptsOf(read.packageJson);
      const found =
        read.packageJson === undefined
          ? 'no package.json'
          : readScripts === undefined
            ? 'a package.json it could not read'
            : 'checks from package.json';
      say(`Read ${repo}: base ${read.base}, ${found}`);
      const suggested = suggestedAlias(repo);
      const alias = await ask(
        `Alias of ${repo}`,
        RepositoryAlias.safeParse(suggested).success && !aliases.has(suggested)
          ? suggested
          : undefined,
        (answer) => {
          const parsed = schemaOf(RepositoryAlias)(answer);
          if ('value' in parsed && aliases.has(parsed.value)) {
            return { refused: `The alias ${parsed.value} is taken` };
          }
          return parsed;
        },
      );
      aliases.add(alias);
      // What it read of a Node repository, proposed for the user to confirm (ADR 0023).
      let scripts = readScripts;
      if (scripts !== undefined) {
        const proposed = nodeChecks(scripts);
        for (const check of CheckName.options) say(`  ${check}: ${proposed[check] ?? 'none'}`);
        say(`  setup: ${read.lockfile ? 'npm ci' : 'none'}`);
        say(`  tools: ${nodeTools(proposed).join(', ') || 'none'}`);
        if (!(await confirm(`Use these for ${repo}? [Y/n]: `, true))) scripts = undefined;
      }
      let checks: Record<string, string | null>;
      if (scripts === undefined) {
        checks = {};
        for (const check of CheckName.options) {
          checks[check] = await ask(
            `${check} check of ${repo} (a command, empty for none)`,
            undefined,
            (answer): Parsed<string | null> => {
              if (answer === '') return { value: null };
              const parsed = schemaOf(Command)(answer);
              return 'value' in parsed ? { value: answer } : parsed;
            },
          );
        }
      } else {
        checks = nodeChecks(scripts);
      }
      // A brewer runs a Node repository's checks itself before it commits (ADR 0163).
      const tools = scripts === undefined ? [] : nodeTools(checks);
      for (const tool of tools) if (!ceiling.includes(tool)) ceiling.push(tool);
      repositories[repo] = {
        alias,
        intake: { labels: [INTAKE_LABEL] },
        source: 'managed',
        base: read.base,
        checks,
        ...(scripts !== undefined && read.lockfile
          ? { setup: { command: 'npm ci', timeout: '10m' } }
          : {}),
        ...(tools.length === 0 ? {} : { tools }),
      };
    }

    const brewed: Json = {
      ...base,
      brewery,
      users: base.users ?? [login],
      concurrency: base.concurrency ?? 1,
      ...(ceiling.length === 0 ? {} : { permissionCeiling: ceiling }),
      repositories,
    };
    const configFile = planObject('foedrum.jsonc', config, brewed);
    const settings = planSettings(readObject(files.read(at('.claude/settings.json'))));
    passes(configFile.path, configFile.text, BreweryConfig);
    passes('models.jsonc', MODELS, ModelsConfig);
    passes(settings.path, settings.text, BreweryClaudeSettings);
    const plans: Planned[] = [
      { ...configFile, question: 'Change foedrum.jsonc (its comments are not kept)? [y/N]: ' },
      // init writes no key of models.jsonc, so one that is there is kept whatever it holds.
      files.exists(at('models.jsonc'))
        ? { path: 'models.jsonc', text: MODELS, changes: [], kept: true }
        : { path: 'models.jsonc', text: MODELS, changes: undefined },
      planIgnore(files.read(at('.gitignore'))),
      settings,
    ];

    // Every question about the files is answered: the repository is created only now, so input
    // that ended early leaves none behind (ADR 0207).
    if (!inClone) {
      try {
        await ports.github.create(brewery, login, isPrivate);
      } catch (error) {
        return refuse(error instanceof Error ? error.message : String(error));
      }
      say(`Created ${isPrivate ? 'the private' : 'the public'} repository ${brewery}`);
      const url = `https://github.com/${brewery}.git`;
      const cloned = await ports.git('', ['clone', '--', url, folder]);
      if (cloned.code !== 0) return refuse(`git clone failed: ${firstLine(cloned)}`);
      say(`Cloned it into ${folder}`);
    }

    for (const plan of plans) {
      if (plan.changes === undefined) {
        files.write(at(plan.path), plan.text);
        written.push(plan.path);
        say(`Wrote ${plan.path}`);
        continue;
      }
      if (plan.changes.length === 0) {
        say(plan.kept === true ? `${plan.path} is kept as it is` : `${plan.path} is up to date`);
        continue;
      }
      say(`${plan.path} would change:`);
      for (const change of plan.changes) say(`  ${change}`);
      if (await confirm(plan.question ?? `Change ${plan.path}? [y/N]: `, false)) {
        files.write(at(plan.path), plan.text);
        written.push(plan.path);
        say(`Changed ${plan.path}`);
      } else {
        say(`Kept ${plan.path}`);
      }
    }
    say(`Written: ${written.length === 0 ? 'none' : written.join(', ')}`);

    for (const repo of targets) await intakeLabel(ports, confirm, repo);
    pushFailed = !(await commitAndPush(
      ports,
      confirm,
      folder,
      plans.map(({ path }) => path),
    ));
  } catch (error) {
    if (error instanceof NoAnswer) {
      return refuse(`no answer to "${error.message}"; nothing more is written`);
    }
    throw error;
  }

  const { ok, report } = await ports.doctor(folder);
  say(report.trimEnd());
  say('');
  say('Each machine runs these once, in the Brewery, for the plugin:');
  for (const command of PLUGIN_COMMANDS) say(command);
  if (folder !== '') say(`The Brewery is in the folder ${folder}`);
  return { exitCode: ok && !pushFailed ? 0 : 1, stdout: '', stderr: '' };
};

type Confirm = (question: string, byDefault: boolean) => Promise<boolean>;

/** The one command that creates the intake label in `repo` later. */
const labelCommand = (repo: string): string =>
  `gh label create ${INTAKE_LABEL} --repo ${repo} --description "${LABEL_DESCRIPTION}" --color ${LABEL_COLOR}`;

/**
 * The intake label in `repo`, after asking (ADR 0207): one that is there is left alone; a no, or a
 * label it cannot read or create, prints the command that creates it, and init goes on.
 */
const intakeLabel = async (ports: InitPorts, confirm: Confirm, repo: string): Promise<void> => {
  const { say } = ports;
  try {
    if (await ports.github.hasLabel(repo, INTAKE_LABEL)) {
      say(`${repo} has the label ${INTAKE_LABEL}`);
      return;
    }
    if (await confirm(`Create the label ${INTAKE_LABEL} in ${repo}? [Y/n]: `, true)) {
      await ports.github.createLabel(repo, INTAKE_LABEL, LABEL_DESCRIPTION);
      say(`Created the label ${INTAKE_LABEL} in ${repo}`);
      return;
    }
    say('To create it later:');
  } catch (error) {
    if (error instanceof NoAnswer) throw error;
    say(error instanceof Error ? error.message : String(error));
  }
  say(labelCommand(repo));
};

/**
 * Commits and pushes the Brewery's files git lists as new or changed, after asking (ADR 0207). A no
 * leaves them written and says how; false when a git call failed.
 */
const commitAndPush = async (
  ports: InitPorts,
  confirm: Confirm,
  folder: string,
  files: readonly string[],
): Promise<boolean> => {
  const { say } = ports;
  const status = await ports.git(folder, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--',
    ...files,
  ]);
  let listed = files;
  let ok = status.code === 0;
  if (ok) {
    const entries = status.stdout.split('\0').map((entry) => entry.slice(3));
    listed = files.filter((file) => entries.includes(file));
    if (listed.length === 0) {
      say('Nothing to commit');
      return true;
    }
    say('To commit and push:');
    for (const file of listed) say(`  ${file}`);
    if (await confirm('Commit and push these? [Y/n]: ', true)) {
      for (const args of [['add', '--', ...listed], ['commit', '-m', COMMIT_MESSAGE], PUSH]) {
        const done = await ports.git(folder, args);
        if (done.code !== 0) {
          say(`git ${args[0]} failed: ${firstLine(done)}`);
          ok = false;
          break;
        }
      }
      if (ok) {
        say('Committed and pushed');
        return true;
      }
    }
  } else {
    say(`git status failed: ${firstLine(status)}`);
  }
  say(`To commit and push them${folder === '' ? '' : `, in ${folder}`}:`);
  say(`git add -- ${listed.join(' ')}`);
  say(`git commit -m "${COMMIT_MESSAGE}"`);
  say(`git ${PUSH.join(' ')}`);
  return ok;
};

const refuse = (message: string): CliResult => ({
  exitCode: 1,
  stdout: '',
  stderr: `foedrum init: ${message}\n`,
});

/** `.gitignore` with `.foedrum/`, added after the lines there. */
const planIgnore = (was: string | undefined): Planned => {
  const path = '.gitignore';
  if (was === undefined) return { path, text: `${IGNORED}\n`, changes: undefined };
  const lines = was.split(/\r?\n/).map((line) => line.trim());
  if (lines.some((line) => ['.foedrum', '/.foedrum'].includes(line.replace(/\/$/, '')))) {
    return { path, text: was, changes: [] };
  }
  // The line ending the file has, so a CRLF file stays one.
  const eol = was.includes('\r\n') ? '\r\n' : '\n';
  const end = was === '' || was.endsWith('\n') ? '' : eol;
  return { path, text: `${was}${end}${IGNORED}${eol}`, changes: [`+ ${IGNORED}`] };
};

/** `.claude/settings.json` with the plugin enabled, merged into the settings there. */
const planSettings = (existing: Existing): Planned => {
  const was = existing.kind === 'read' ? existing.value : {};
  const enabled = isRecord(was.enabledPlugins) ? was.enabledPlugins : {};
  return planObject('.claude/settings.json', existing, {
    ...was,
    enabledPlugins: { ...enabled, [PLUGIN]: true },
  });
};
