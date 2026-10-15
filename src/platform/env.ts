// Environment variables that differ between operating systems (architecture §13).

/**
 * The key under which `platform` knows an environment variable: Windows does not tell names
 * apart by case, so `Path` and `PATH` are one variable there; other platforms keep them apart.
 */
export const envNameKey =
  (platform: NodeJS.Platform) =>
  (name: string): string =>
    platform === 'win32' ? name.toUpperCase() : name;
