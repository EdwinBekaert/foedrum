// Path comparison that respects case-insensitive file systems (architecture §13, paths):
// Windows and macOS treat `C:\Code` and `c:/code` as the same folder.

import { posix, win32 } from 'node:path';

const pathModule = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix);

/** Whether the platform's file system takes two paths that differ only in case for one. */
export const foldsCase = (platform = process.platform): boolean =>
  platform === 'win32' || platform === 'darwin';

// A resolved form of the path in which equal paths are equal strings.
const comparable = (path: string, platform: NodeJS.Platform): string => {
  const resolved = pathModule(platform).resolve(path);
  return foldsCase(platform) ? resolved.toLowerCase() : resolved;
};

export const samePath = (a: string, b: string, platform = process.platform): boolean =>
  comparable(a, platform) === comparable(b, platform);

// The path of `child` relative to `parent` when it lies strictly inside it, otherwise undefined.
// The result uses forward slashes on every platform.
export const pathInside = (
  parent: string,
  child: string,
  platform = process.platform,
): string | undefined => {
  const { relative, resolve, sep, isAbsolute } = pathModule(platform);
  const path = relative(comparable(parent, platform), comparable(child, platform));
  if (path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    return undefined;
  }
  // Take the segments from the original child, so the result keeps its case.
  const segments = path.split(sep).length;
  return resolve(child).split(sep).slice(-segments).join('/');
};
