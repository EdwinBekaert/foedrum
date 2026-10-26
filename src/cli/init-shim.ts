// The `foedrum` command `foedrum init` writes into a user folder on the PATH (ADR 0210): a shim
// that runs this checkout's entry point with the node on the PATH, until `npx foedrum` replaces
// it. The ports are the platform, its environment and home, the files, and the PATH lookup.

export interface ShimPorts {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** The user's home, the user profile on Windows. */
  home: string;
  /** The entry point of the Foedrum that runs: `<checkout>/src/cli/main.ts`. */
  entry: string;
  /** Whether `folder` is there as a folder this process may write in. */
  writable: (folder: string) => boolean;
  /** The text of the file at `path`, or `undefined` when there is none. */
  read: (path: string) => string | undefined;
  /** Writes `text` at `path`, runnable (mode 0755) when `executable`. */
  write: (path: string, text: string, executable: boolean) => void;
  /** The file a command name runs in this terminal (`resolveExecutable`). */
  resolve: (name: string) => string | undefined;
}

export interface ShimTerminal {
  /** Asks one question and gives its answer; throws when standard input has ended. */
  answer: (question: string) => Promise<string>;
  say: (line: string) => void;
}

/** Offers the `foedrum` command after asking, or says how to write it by hand (ADR 0210). */
export const offerShim = async (_ports: ShimPorts, _terminal: ShimTerminal): Promise<void> => {
  throw new Error('not implemented');
};
