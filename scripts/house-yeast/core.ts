// Decides which house-yeast rules a lens of /brew-review reads, and when a lesson becomes a
// proposed rule (issue #32, ADR 0122). scripts/house-yeast.ts reads and writes the files.

import type { HouseYeastCandidate, HouseYeastRule } from '../../src/schemas/house-yeast.ts';

export interface RuleFile {
  path: string;
  text: string;
}

export interface Rule {
  path: string;
  rule: HouseYeastRule;
  body: string;
}

export interface Rules {
  rules: Rule[];
  invalid: { path: string; reason: string }[];
}

export interface Priced {
  rule: Rule;
  tokens: number;
}

export interface Selection {
  selected: Priced[];
  cut: Priced[];
}

export interface Proposal {
  rule: HouseYeastRule;
  body: string;
  reviews: number;
}

export const defaultBudget = 2000;

export const readRules = (_files: readonly RuleFile[]): Rules => {
  throw new Error('not implemented');
};

export const changedFiles = (_nameStatus: string): string[] => {
  throw new Error('not implemented');
};

export const selectRules = (
  _rules: readonly Rule[],
  _change: { files: readonly string[]; lens: string },
  _budget: number = defaultBudget,
): Selection => {
  throw new Error('not implemented');
};

export const renderRules = (_lens: string, _selection: Selection): string => {
  throw new Error('not implemented');
};

export const readCandidates = (
  _jsonl: string,
): { candidates: HouseYeastCandidate[]; invalid: string[] } => {
  throw new Error('not implemented');
};

export const proposeRule = (
  _candidates: readonly HouseYeastCandidate[],
  _lesson: string,
  _asked: boolean,
): Proposal | undefined => {
  throw new Error('not implemented');
};

export const formatRule = (_rule: HouseYeastRule, _body: string): string => {
  throw new Error('not implemented');
};
