// npm run demo -- ladder's brewers (ADR 0294): not implemented yet.

import type { Scripted } from '../../test/helpers/nip-fixture.ts';

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

export const planFrom = (_lib: string | undefined, _web: string | undefined): Scripted => {
  throw new Error('not implemented');
};

export const bumped = (_manifest: string, _prompt: string): string => {
  throw new Error('not implemented');
};

export const releaseLines = (_prompt: string): string[] => {
  throw new Error('not implemented');
};

export const turnOf = (
  _stepId: string,
  _read: (path: string) => string | undefined,
  _prompt: string,
): Scripted => {
  throw new Error('not implemented');
};
