// `node scripts/with-checkout-tmp.ts <node arguments…>`: runs this node with the arguments and
// with the system temp directory moved into the checkout, then removes it (issue #70).

export interface WithCheckoutTmpOptions {
  args: string[];
  env: NodeJS.ProcessEnv;
  execPath: string;
  // Creates a fresh folder for this run and returns its path.
  makeTempDir: () => string;
  removeDir: (path: string) => Promise<void>;
  // Runs a program with its output on this terminal; resolves to its exit code, null when it
  // could not start or was killed.
  run: (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<number | null>;
  write: (text: string) => void;
}

// Resolves to the exit code.
export const withCheckoutTmp = async (_options: WithCheckoutTmpOptions): Promise<number> => {
  throw new Error('not implemented');
};
