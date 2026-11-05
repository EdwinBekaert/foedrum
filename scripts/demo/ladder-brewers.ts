// npm run demo -- ladder's brewers (ADR 0294): the Brewmaster that plans the order from the folder of
// checkouts it runs in (ADR 0301), and the Cellarman of each sub-order, in serve's runner seam, so
// each attempt reads and commits in its own worktree and no model is asked. Each one decides from
// what it reads, never from a fixed answer: the Brewmaster from the two manifests, the Cellarman
// from its worktree's manifest, and the second sub-order's Cellarman bumps the library to the tag
// its prompt's `release` input names (ADR 0291).

import { join } from 'node:path';
import type { ClaudeAttemptPlan } from '../../src/brewers/claude-runner.ts';
import { attemptKey } from '../../src/engine/attempt-key.ts';
import type { AttemptEnd, AttemptStart, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import type { Git } from '../../src/workspace/git.ts';
import { behave, fakeBrewerRunner } from '../../test/helpers/fake-brewer-runner.ts';
import { type Scripted, scriptedOutDoc } from '../../test/helpers/nip-fixture.ts';
import { DEMO_GIT_CONFIG } from './brewer.ts';

/** The library, its package, its version on main, and the application that depends on it. */
export const LIB = 'demo/lib';
export const WEB = 'demo/web';
export const PACKAGE = '@demo/greet';
export const VERSION = '1.3.0';
/** The aliases the Brewery gives them, which name their folders in a folder of checkouts. */
export const ALIASES = { [LIB]: 'lib', [WEB]: 'web' } as const;
/** The recipe both sub-orders brew with: the Cellarman, then the pull request. */
export const LADDER_RECIPE = 'ladder';

/** The library's greeting after the first sub-order: it takes a language. */
export const GREET_FR =
  "export function greet(name, language) {\n  return (language === 'fr' ? 'Bonjour, ' : 'Hello, ') + name + '!';\n}\n";

/** A manifest's fields the brewers read; undefined when the text is not one. */
const manifestOf = (
  text: string | undefined,
): { name?: string; dependencies?: Record<string, string> } | undefined => {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The Brewmaster's plan of the order from the manifests it read in the folder of checkouts: the
 * library's package and the application that depends on it. It throws when either folder has no
 * manifest, or the application does not depend on the library, so the plan comes from what it read.
 */
export const planFrom = (lib: string | undefined, web: string | undefined): Scripted => {
  const library = manifestOf(lib)?.name;
  const pinned = library === undefined ? undefined : manifestOf(web)?.dependencies?.[library];
  if (library === undefined || pinned === undefined) {
    throw new Error(
      `the Brewmaster read no ${ALIASES[LIB]}/package.json, or no ${ALIASES[WEB]}/package.json that depends on it`,
    );
  }
  return {
    files: {},
    message: '',
    summary: `Greet in French in ${library} first, then bump ${WEB} to its release.`,
    doc: {
      subOrders: [
        {
          id: 'greet',
          title: 'greet takes a language',
          repo: LIB,
          size: { lines: 10, mechanism: 'a second parameter' },
          doneWhen: "greet('Ann', 'fr') returns 'Bonjour, Ann!'",
          touches: [{ path: 'greet.mjs' }],
          recipe: LADDER_RECIPE,
          why: 'one small change in the library',
          ready: true,
        },
        {
          id: 'bump',
          title: `${WEB} uses the release of ${library} that greets in French`,
          repo: WEB,
          size: { lines: 2, mechanism: 'one dependency bumped' },
          doneWhen: `${WEB}'s package.json depends on the release, not on ${pinned}`,
          touches: [{ path: 'package.json' }],
          dependencies: [{ on: 'greet', kind: 'release' }],
          recipe: LADDER_RECIPE,
          why: `${WEB} takes ${library} from its releases, so it waits for one`,
          ready: true,
        },
      ],
      alternatives: {
        considered: [{ cut: 'one sub-order', whyNot: 'one sub-order never spans repositories' }],
        whyThis: 'the library first, released, then the application',
      },
      assumptions: [`${LIB}'s CI releases it when its pull request merges.`],
    },
  };
};

/** The system map's line for the application's dependency on the library (ADR 0317). */
export const MAPPED_DEPENDENCY = `depends on \`${PACKAGE}\` from ${LIB} by version \`${VERSION}\``;

/** The tag of the release the prompt's `release` input names, as written (ADR 0291). */
const TAG = /^- Tag, as written: (\S+)$/m;

/**
 * The application's manifest with the library bumped to the release its prompt names: the tag
 * without its `v`. It throws when the prompt names no release, so nothing is hard-coded.
 */
export const bumped = (manifest: string, prompt: string): string => {
  const tag = TAG.exec(prompt)?.[1];
  if (tag === undefined) throw new Error('the prompt names no release to bump to');
  const version = tag.replace(/^v/, '');
  const pinned = `"${PACKAGE}": "${VERSION}"`;
  if (!manifest.includes(pinned)) throw new Error(`package.json has no ${pinned}`);
  return manifest.replace(pinned, `"${PACKAGE}": "${version}"`);
};

/** The `release` input's lines in the prompt, between its tags; none without one. */
export const releaseLines = (prompt: string): string[] => {
  const lines = prompt.split(/\r?\n/);
  const opening = /^<(untrusted-input-\w+) source="[^"]*" name="release">$/;
  const open = lines.findIndex((line) => opening.test(line));
  if (open === -1) return [];
  const [, tag = ''] = opening.exec(lines[open] ?? '') ?? [];
  const close = lines.indexOf(`</${tag}>`, open);
  return lines.slice(open + 1, close === -1 ? undefined : close);
};

/** The lens steps of the default mash's group (ADR 0321). */
const PLAN_LENSES: readonly string[] = ['coverage', 'sizing', 'naive-reader'];

/**
 * What an attempt commits, from what it reads: the plan from the folder of checkouts, the
 * library's change in the library's worktree, and the bump in the application's.
 */
export const turnOf = (
  stepId: string,
  read: (path: string) => string | undefined,
  prompt: string,
): Scripted => {
  if (stepId === 'plan') {
    // The system map names the link the plan rests on before any manifest is opened (ADR 0317).
    if (!prompt.includes(MAPPED_DEPENDENCY)) {
      throw new Error(`the Brewmaster's repositories input maps no dependency of ${WEB} on ${LIB}`);
    }
    return planFrom(
      read(join(ALIASES[LIB], 'package.json')),
      read(join(ALIASES[WEB], 'package.json')),
    );
  }
  // The default mash's Tasters review that plan side by side, and approve it (ADR 0321).
  if (PLAN_LENSES.includes(stepId)) {
    return {
      files: {},
      message: '',
      summary: `The plan reads well through ${stepId}.`,
      tasting: { verdict: 'approve', findings: [] },
    };
  }
  if (stepId !== 'implement') throw new Error(`the ladder has no brewer for step ${stepId}`);
  const manifest = read('package.json') ?? '';
  if (manifestOf(manifest)?.name === PACKAGE) {
    return {
      files: { 'greet.mjs': GREET_FR },
      message: 'Greet in French',
      summary: "greet('Ann', 'fr') says 'Bonjour, Ann!'.",
    };
  }
  return {
    files: { 'package.json': bumped(manifest, prompt) },
    message: `Use the release of ${PACKAGE} that greets in French`,
    summary: `${WEB} depends on the ${PACKAGE} its release input names.`,
  };
};

export interface LadderBrewersOptions {
  /** The attempt's plan, serve's own: its working directory and its prompt. */
  plan: (start: AttemptStart) => Promise<ClaudeAttemptPlan>;
  git: Git;
  read: (path: string) => string | undefined;
  write: (path: string, text: string) => void;
  /** Called with the prompt the attempt was planned with, once it has brewed. */
  brewed?: (ref: AttemptStart['ref'], prompt: string) => void;
}

/** The ladder's brewers in serve's runner seam: each attempt writes, commits and settles. */
export const ladderBrewers = (options: LadderBrewersOptions): BrewerRunner => {
  const { plan, git, read, write, brewed } = options;
  const played = new Map<string, Scripted>();
  const settled = fakeBrewerRunner(({ ref }) => {
    const done = behave.succeed();
    const scripted = played.get(attemptKey.encode(ref));
    if (done.kind !== 'settle' || scripted === undefined) return done;
    const count = Object.keys(scripted.files).length === 0 ? 0 : 1;
    const commits = { kind: 'counted', count } as const;
    return { ...done, facts: { ...done.facts, outDoc: scriptedOutDoc(scripted), commits } };
  });
  /** Reads, writes and commits the attempt's change and its out doc; why it could not, if not. */
  const brew = async (start: AttemptStart): Promise<string | undefined> => {
    try {
      const planned = await plan(start);
      const scripted = turnOf(
        start.ref.stepId,
        (path) => read(join(planned.cwd, path)),
        planned.prompt,
      );
      played.set(attemptKey.encode(start.ref), scripted);
      const { files, message } = scripted;
      for (const [path, text] of Object.entries(files)) write(join(planned.cwd, path), text);
      write(join(planned.cwd, start.limits.outDoc.file), scriptedOutDoc(scripted));
      if (Object.keys(files).length > 0) {
        for (const args of [
          ['add', '--', ...Object.keys(files)],
          ['commit', '-q', '-m', message],
        ]) {
          const result = await git(planned.cwd, args, { config: DEMO_GIT_CONFIG });
          if (result.code !== 0) {
            return `git ${args[0]}: ${(result.stderr || result.stdout).trim() || `exit code ${result.code}`}`;
          }
        }
      }
      brewed?.(start.ref, planned.prompt);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  return {
    progress: settled.progress,
    start: (start) => {
      let stopped = false;
      const ended = brew(start).then((failure): AttemptEnd | Promise<AttemptEnd> => {
        if (stopped) return { ending: { kind: 'cancelled' } };
        if (failure !== undefined) {
          const reason = `the scripted brewer could not brew: ${failure}`;
          return { ending: { kind: 'failed', retryable: false, reason } };
        }
        return settled.start(start).ended;
      });
      return {
        ended,
        stop: () => {
          stopped = true;
        },
      };
    },
  };
};
