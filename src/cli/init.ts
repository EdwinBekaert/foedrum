// `foedrum init` (ADR 0199, ADR 0207): asks a few questions on the terminal, builds a Brewery's
// files from the answers and from what GitHub says of each target repository, checks each against
// its schema, and, outside a clone, creates the Brewery's repository and clones it. It writes the
// new files and asks before changing one that is there, offers the intake label in each target
// repository, commits and pushes after asking, offers the foedrum command on the PATH (ADR 0210),
// then runs doctor. The ports are the terminal, the files, GitHub through gh, git, doctor and the
// machine the command goes on; init-main.ts gives the real ones.

import { parseJsonc } from '../formats/jsonc.ts';
import { LABEL_COLOR } from '../github/brewery-repository.ts';
import type { RepositoryFacts } from '../github/repository-facts.ts';
import { BreweryConfig } from '../schemas/brewery-config.ts';
import { BreweryClaudeSettings } from '../schemas/brewery-settings.ts';
import type { InitCommand } from '../schemas/commands.ts';
import { Repo } from '../schemas/events.ts';
import { RepositoryAlias } from '../schemas/ids.ts';
import { ModelsConfig } from '../schemas/models.ts';
import { CheckName, Command } from '../schemas/primitives.ts';
import { readJsonc } from '../schemas/read.ts';
import type { z } from '../schemas/zod.ts';
import { firstLine } from '../workspace/clone-git.ts';
import type { GitResult } from '../workspace/git.ts';
import { offerShim, type ShimPorts, shimChoice } from './init-shim.ts';
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
  /** The machine the `foedrum` command is written on (ADR 0210). */
  shim: ShimPorts;
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
/** A name Windows keeps for a device, before any dot: no folder can have it (CON, NUL, COM1, …). */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
/** No aliases of its own: every alias is Foedrum's default (ADR 0153). */
const MODELS = `// Model aliases over Foedrum's defaults (ADR 0153), such as { "builder": "opus" }.
{ "models": {} }
`;

/** Standard input ended before an answer: init stops where it is. */
class NoAnswer extends Error {}

/** An option's answer that does not pass, or a question `--no-input` leaves unanswered: exit 2. */
class Refused extends Error {}

export type Parsed<T> = { value: T } | { refused: string };

/** The options a question may be keyed by a repository or file in, `<key>=<answer>` (ADR 0212). */
const KEYED = ['alias', 'use-checks', 'check', 'change', 'label'] as const;

/** The option that answers a question: its name, and the repository or file it is keyed by. */
interface Option {
  name: keyof InitAnswers;
  key?: string;
}

/** An option as given on the command line, with `answer`. */
const optionWith = ({ name, key }: Option, answer: string): string =>
  key === undefined ? `--${name} ${answer}` : `--${name} ${key}=${answer}`;

/** A question as its refusal names it: the question quoted, then its default. */
const quoted = (question: string): string => {
  const asked = question.replace(/: $/, '');
  const [, text = asked, fallback] = /^(.*?)( \[[^\]]*\])?$/.exec(asked) ?? [];
  return `"${text}"${fallback ?? ''}`;
};

/** A yes or no from its option: y, yes, n or no, any case; empty for the default. */
const yesNo = (answer: string, byDefault: boolean): Parsed<boolean> => {
  if (answer === '') return { value: byDefault };
  if (/^y(?:es)?$/i.test(answer)) return { value: true };
  if (/^no?$/i.test(answer)) return { value: false };
  return { refused: 'Answer y or n' };
};

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

/** The answers given as options, each as it would be typed (ADR 0212). */
export type InitAnswers = Omit<InitCommand, 'command'>;

/** Runs `foedrum init` through `ports`, with the answers `given` as options. */
export const runInit = async (ports: InitPorts, given: InitAnswers = {}): Promise<CliResult> => {
  const { say, files } = ports;
  // Outside a clone, init creates the repository and clones it into a folder of its name (ADR 0207).
  const inClone = files.exists('.git');
  // The clone's folder from the working directory, `''` inside one; known once the name is asked.
  let folder = '';
  const at = (path: string): string => (folder === '' ? path : `${folder}/${path}`);
  const noInput = given['no-input'] === true;

  // The keyed options' answers, by option and key, each given once (ADR 0212).
  const keyed = new Map<string, string>();
  for (const name of KEYED) {
    for (const item of given[name] ?? []) {
      const split = item.indexOf('=');
      if (split <= 0) return usage(`--${name} ${item}: Give it as <key>=<answer>`);
      const id = `${name} ${item.slice(0, split)}`;
      if (keyed.has(id)) return usage(`--${name} ${item.slice(0, split)} is given twice`);
      keyed.set(id, item.slice(split + 1));
    }
  }
  const optionValue = (option: Option): string | undefined => {
    if (option.key !== undefined) return keyed.get(`${option.name} ${option.key}`);
    const value = given[option.name];
    return typeof value === 'string' ? value : undefined;
  };

  // The answer `option` gives, or else asks until one passes `parse`, which says why it does not.
  // An option's answer that does not pass, or none under --no-input, refuses init (ADR 0212).
  const answer = async <T>(
    question: string,
    option: Option,
    parse: (answer: string, typed: boolean) => Parsed<T> | Promise<Parsed<T>>,
  ): Promise<T> => {
    const value = optionValue(option);
    if (value !== undefined) {
      const parsed = await parse(value.trim(), false);
      if ('value' in parsed) return parsed.value;
      throw new Refused(`${optionWith(option, value)}: ${parsed.refused}`);
    }
    if (noInput) {
      throw new Refused(`no answer to ${quoted(question)}; add ${optionWith(option, '<answer>')}`);
    }
    for (;;) {
      const typed = await ports.ask(question);
      if (typed === undefined) throw new NoAnswer(question.replace(/:? (?:\[.*)?$/, ''));
      const parsed = await parse(typed.trim(), true);
      if ('value' in parsed) return parsed.value;
      say(`  ${parsed.refused}`);
    }
  };

  // Asks until an answer passes `parse`; an empty answer takes `fallback`.
  const ask = <T>(
    question: string,
    fallback: string | undefined,
    option: Option,
    parse: (answer: string) => Parsed<T> | Promise<Parsed<T>>,
  ): Promise<T> =>
    answer(`${question}${fallback ? ` [${fallback}]` : ''}: `, option, (given) =>
      parse(given || (fallback ?? '')),
    );

  // A yes or no, `byDefault` for an empty answer; typed, anything but a yes is a no.
  const confirm = (question: string, byDefault: boolean, option: Option): Promise<boolean> =>
    answer(question, option, (given, typed) =>
      typed && given !== '' ? { value: /^y(?:es)?$/i.test(given) } : yesNo(given, byDefault),
    );

  // A question init asks after the repository is created, answered now when its option is given,
  // or refused now under --no-input after the lines it shows: before anything is created.
  const early = async (option: Option, lines: readonly string[], check: () => Promise<unknown>) => {
    if (optionValue(option) === undefined) {
      if (!noInput) return;
      for (const line of lines) say(line);
    }
    await check();
  };

  // Whether each target has the intake label, read once (ADR 0207).
  const labels = new Map<string, Promise<boolean>>();
  const labelled = (repo: string): Promise<boolean> => {
    const read = labels.get(repo) ?? ports.github.hasLabel(repo, INTAKE_LABEL);
    labels.set(repo, read);
    return read;
  };

  // The files written or changed, said before doctor's report.
  const written: string[] = [];
  // Whether a git call of the commit and push failed, which ends init in 1.
  let pushFailed = false;
  // What init made on GitHub and in a new folder, which a refusal after it names.
  let created = '';
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
      { name: 'brewery' },
      schemaOf(Repo),
    );
    let isPrivate = true;
    if (!inClone) {
      const name = brewery.split('/')[1] ?? '';
      // The clone's folder must be one on every platform the Brewery's machines run.
      if (WINDOWS_DEVICE.test(name) || name.endsWith('.')) {
        return refuse(`${name} cannot be a folder on Windows; choose another name`);
      }
      // init creates a repository, never takes one over.
      if (await ports.github.exists(brewery)) {
        return refuse(
          `${brewery} is on GitHub already; run init in its clone (git clone https://github.com/${brewery}.git)`,
        );
      }
      if (files.exists(name)) {
        return refuse(`the folder ${name} is there already; run init where it is not`);
      }
      folder = name;
      isPrivate = await ask(
        'Private or public',
        'private',
        { name: 'visibility' },
        (answer): Parsed<boolean> => {
          if (answer === 'private' || answer === 'public') return { value: answer === 'private' };
          return { refused: 'Answer private or public' };
        },
      );
    }

    // The repositories foedrum.jsonc has keep their entries as they are.
    const kept: Json = isRecord(base.repositories) ? base.repositories : {};
    const facts = new Map<string, RepositoryFacts>();
    const targets = await ask(
      'Target repositories (owner/name, separated by spaces)',
      Object.keys(kept).join(' '),
      { name: 'targets' },
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
        { name: 'alias', key: repo },
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
        const use = { name: 'use-checks', key: repo } as const;
        if (!(await confirm(`Use these for ${repo}? [Y/n]: `, true, use))) scripts = undefined;
      }
      let checks: Record<string, string | null>;
      if (scripts === undefined) {
        checks = {};
        for (const check of CheckName.options) {
          checks[check] = await ask(
            `${check} check of ${repo} (a command, empty for none)`,
            undefined,
            { name: 'check', key: `${repo}:${check}` },
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

    // The questions after the repository is created, answered from their options now, or refused
    // under --no-input, so nothing is created or written before a refusal (ADR 0212).
    for (const plan of plans) {
      if (plan.changes === undefined || plan.changes.length === 0) continue;
      const option = { name: 'change', key: plan.path } as const;
      await early(option, changeLines(plan), () => confirm(changeQuestion(plan), false, option));
    }
    for (const repo of targets) {
      const option = { name: 'label', key: repo } as const;
      if (optionValue(option) === undefined && !noInput) continue;
      // A label it cannot read is said where init would ask.
      const has = await labelled(repo).catch(() => true);
      if (!has) await early(option, [], () => confirm(labelQuestion(repo), true, option));
    }
    await early({ name: 'push' }, [], () => confirm(PUSH_QUESTION, true, { name: 'push' }));
    const shim = shimChoice(ports.shim);
    if (shim.kind === 'repoint') {
      const option = { name: 'repoint' } as const;
      await early(option, [], () => confirm(shim.question, false, option));
    } else if (shim.kind === 'folders') {
      const option = { name: 'shim' } as const;
      await early(option, shim.lines, () => answer(shim.question, option, shim.parse));
    }

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
      created = `; ${brewery} is created and cloned into the folder ${folder}`;
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
      for (const line of changeLines(plan)) say(line);
      const option = { name: 'change', key: plan.path } as const;
      if (await confirm(changeQuestion(plan), false, option)) {
        files.write(at(plan.path), plan.text);
        written.push(plan.path);
        say(`Changed ${plan.path}`);
      } else {
        say(`Kept ${plan.path}`);
      }
    }
    say(`Written: ${written.length === 0 ? 'none' : written.join(', ')}`);

    for (const repo of targets) await intakeLabel(ports, confirm, labelled, repo);
    pushFailed = !(await commitAndPush(
      ports,
      confirm,
      folder,
      plans.map(({ path }) => path),
    ));
    // The foedrum command on the PATH, before doctor's report (ADR 0210).
    await offerShim(ports.shim, {
      say,
      ask: (question, name, parse) => answer(question, { name }, parse),
      confirm: (question, name, byDefault) => confirm(question, byDefault, { name }),
    });
  } catch (error) {
    if (error instanceof Refused) return usage(error.message);
    if (error instanceof NoAnswer) {
      return refuse(`no answer to "${error.message}"; nothing more is written${created}`);
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

type Confirm = (question: string, byDefault: boolean, option: Option) => Promise<boolean>;

const PUSH_QUESTION = 'Commit and push these? [Y/n]: ';

const labelQuestion = (repo: string): string =>
  `Create the label ${INTAKE_LABEL} in ${repo}? [Y/n]: `;

const changeQuestion = (plan: Planned): string => plan.question ?? `Change ${plan.path}? [y/N]: `;

/** What a file that is there would change, said before asking. */
const changeLines = (plan: Planned): string[] => [
  `${plan.path} would change:`,
  ...(plan.changes ?? []).map((change) => `  ${change}`),
];

/** The one command that creates the intake label in `repo` later. */
const labelCommand = (repo: string): string =>
  `gh label create ${INTAKE_LABEL} --repo ${repo} --description "${LABEL_DESCRIPTION}" --color ${LABEL_COLOR}`;

/**
 * The intake label in `repo`, after asking (ADR 0207): one that is there is left alone; a no, or a
 * label it cannot read or create, prints the command that creates it, and init goes on.
 */
const intakeLabel = async (
  ports: InitPorts,
  confirm: Confirm,
  labelled: (repo: string) => Promise<boolean>,
  repo: string,
): Promise<void> => {
  const { say } = ports;
  try {
    if (await labelled(repo)) {
      say(`${repo} has the label ${INTAKE_LABEL}`);
      return;
    }
    if (await confirm(labelQuestion(repo), true, { name: 'label', key: repo })) {
      await ports.github.createLabel(repo, INTAKE_LABEL, LABEL_DESCRIPTION);
      say(`Created the label ${INTAKE_LABEL} in ${repo}`);
      return;
    }
    say('To create it later:');
  } catch (error) {
    if (error instanceof NoAnswer || error instanceof Refused) throw error;
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
  if (!ok) {
    say(`git status failed: ${firstLine(status)}`);
  } else {
    const entries = status.stdout.split('\0').map((entry) => entry.slice(3));
    listed = files.filter((file) => entries.includes(file));
    if (listed.length === 0) {
      say('Nothing to commit');
      return true;
    }
    // The push sends every commit no remote has, so the question lists them with the files.
    const unpushed = await commitsNotPushed(ports, folder);
    ok = unpushed !== undefined;
    if (unpushed !== undefined) {
      say('To commit and push:');
      for (const file of listed) say(`  ${file}`);
      if (unpushed.length > 0) {
        say('Also pushed, not on GitHub yet:');
        for (const commit of unpushed) say(`  ${commit}`);
      }
      if (await confirm(PUSH_QUESTION, true, { name: 'push' })) {
        // The commit takes the listed files only, never what else is staged.
        const commit = ['commit', '-m', COMMIT_MESSAGE, '--', ...listed];
        for (const args of [['add', '--', ...listed], commit, PUSH]) {
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
    }
  }
  say(`To commit and push them${folder === '' ? '' : `, in ${folder}`}:`);
  say(`git add -- ${listed.join(' ')}`);
  say(`git commit -m "${COMMIT_MESSAGE}" -- ${listed.join(' ')}`);
  say(`git ${PUSH.join(' ')}`);
  return ok;
};

/**
 * The commits on HEAD that origin, the remote the push goes to, lacks, as `<hash> <subject>`: none on a branch without a commit
 * yet; `undefined`, after saying git's line, when git cannot tell.
 */
const commitsNotPushed = async (
  ports: InitPorts,
  folder: string,
): Promise<string[] | undefined> => {
  const head = await ports.git(folder, ['rev-parse', '-q', '--verify', 'HEAD']);
  if (head.code === 1) return [];
  const log =
    head.code === 0
      ? await ports.git(folder, ['log', '--format=%h %s', 'HEAD', '--not', '--remotes=origin'])
      : head;
  if (log.code !== 0) {
    ports.say(`git ${head.code === 0 ? 'log' : 'rev-parse'} failed: ${firstLine(log)}`);
    return undefined;
  }
  return log.stdout.split(/\r?\n/).filter((line) => line !== '');
};

/** A command line init cannot run: an option's answer that does not pass, or one missing. */
const usage = (message: string): CliResult => ({ ...refuse(message), exitCode: 2 });

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
