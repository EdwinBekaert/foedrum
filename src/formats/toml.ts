// A small reader of TOML's statements for the manifests Foedrum reads (ADR 0320). Pure.

export class NotToml extends Error {}

export type TomlValue = { kind: 'string'; text: string } | { kind: 'table' } | { kind: 'other' };

export interface TomlEntry {
  path: readonly string[];
  value: TomlValue;
}

export const readToml = (_text: string): TomlEntry[] => {
  throw new Error('not implemented');
};
