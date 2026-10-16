// The permission rules Claude Code warns about at startup, or skips, because they never match
// what they seem to (#42). The list follows the Claude Code docs, which can change:
// https://code.claude.com/docs/en/permissions#match-by-input-parameter
// https://code.claude.com/docs/en/permissions#tool-name-wildcards
// https://code.claude.com/docs/en/permissions#read-and-edit
// https://code.claude.com/docs/en/errors#has-a-wildcard-before-the-rest-of-the-command
// https://code.claude.com/docs/en/errors#is-not-matched-by-file-permission-checks

export interface Permissions {
  allow?: string[];
  ask?: string[];
  deny?: string[];
}

// One line per rule Claude Code would warn about, naming the list, the rule and why.
export const startupWarnings = (_permissions: Permissions): string[] => {
  throw new Error('not implemented');
};
