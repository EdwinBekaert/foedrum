// Path comparison that respects case-insensitive file systems (architecture §13, paths):
// Windows and macOS treat `C:\Code` and `c:/code` as the same folder.

export const samePath = (_a: string, _b: string, _platform = process.platform): boolean => {
  throw new Error('not implemented');
};

// The path of `child` relative to `parent` when it lies strictly inside it, otherwise undefined.
export const pathInside = (
  _parent: string,
  _child: string,
  _platform = process.platform,
): string | undefined => {
  throw new Error('not implemented');
};
