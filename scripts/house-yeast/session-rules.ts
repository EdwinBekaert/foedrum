// The house-yeast rules as path-scoped Claude Code rule files, which Foedrum's own sessions load
// for the files they read or change (#677, ADR 0271). scripts/generate-house-yeast-rules.ts
// writes them.

import {
  byCodeUnits,
  languages,
  type Rule,
  type RuleFile,
  readRules,
  section,
} from '../../src/brewers/house-yeast.ts';

export interface SessionRuleFile {
  name: string;
  text: string;
}

// A session starts in the main checkout and works in a worktree under .claude/worktrees/, and Claude
// Code matches `paths` from the main checkout, so a glob matches under any folder.
const anywhere = (glob: string): string => (glob.startsWith('**/') ? glob : `**/${glob}`);

// A rule's paths are its globs, which in every rule so far already pin the language when it names
// one too: `paths` cannot ask for both. A rule with only a language matches its extensions, and
// one with neither matches every file, as it matches every change (ADR 0015). It is named after
// its globs, its language, or `everywhere`.
const pathsOf = ({ scope }: Rule['rule']): { name: string; paths: string[] } => {
  if (scope.globs !== undefined) {
    const globs = [...new Set(scope.globs)].sort();
    return { name: globs.join('-'), paths: [...new Set(globs.map(anywhere))] };
  }
  const { language } = scope;
  if (language === undefined) return { name: 'everywhere', paths: ['**/*'] };
  const extensions = Object.keys(languages)
    .filter((extension) => languages[extension] === language)
    .map((extension) => extension.slice(1));
  // A brace of one item is read as text, so `**/*.{md}` would match no file.
  const pattern = extensions.length === 1 ? extensions[0] : `{${extensions.join(',')}}`;
  return { name: language, paths: [`**/*.${pattern}`] };
};

// Globs without a letter or digit (`**/*`) match every file, as a rule without a scope does.
const slug = (key: string): string =>
  key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'everywhere';

const head =
  '<!-- Generated from .foedrum/house-yeast/ by npm run house-yeast:rules; do not edit. -->\n\n' +
  '# House yeast\n\n' +
  "Rules learned from reviews of Foedrum's own pull requests (ADR 0122), for the files this " +
  'session reads or changes (ADR 0271). Follow them where your change meets them: /brew-review ' +
  'looks for what they describe.\n';

const render = (paths: readonly string[], rules: readonly Rule[]): string =>
  `---\npaths:\n${paths.map((path) => `  - ${JSON.stringify(path)}\n`).join('')}---\n\n${head}\n` +
  rules.map(section).join('\n');

/** One rule file per set of paths, from the house-yeast rule files, and the rule files that are invalid. */
export const sessionRuleFiles = (
  files: readonly RuleFile[],
): { files: SessionRuleFile[]; invalid: { path: string; reason: string }[] } => {
  const { rules, invalid } = readRules(files);
  // Rules with the same paths share a file.
  const groups = new Map<string, { name: string; paths: string[]; rules: Rule[] }>();
  for (const rule of rules) {
    if (rule.rule.status !== 'active') continue;
    const { name, paths } = pathsOf(rule.rule);
    const key = JSON.stringify(paths);
    const group = groups.get(key) ?? { name: slug(name), paths, rules: [] };
    // Rules whose globs differ but give the same paths share the first of their names, so the
    // order the rules were read in does not name the file.
    if (byCodeUnits(slug(name), group.name) < 0) group.name = slug(name);
    group.rules.push(rule);
    groups.set(key, group);
  }
  const taken = new Set<string>();
  const generated = [...groups]
    .sort(([a], [b]) => byCodeUnits(a, b))
    .map(([, group]) => {
      // Two sets of globs can make one name (docs/a.md, docs-a.md): the later one is numbered.
      let name = group.name;
      for (let n = 2; taken.has(name); n++) name = `${group.name}-${n}`;
      taken.add(name);
      const sorted = group.rules.sort((a, b) => byCodeUnits(a.rule.id, b.rule.id));
      return { name: `${name}.md`, text: render(group.paths, sorted) };
    });
  return { files: generated.sort((a, b) => byCodeUnits(a.name, b.name)), invalid };
};
