// Replacing a file by renaming another over it (architecture §13, file locks). On Windows the
// rename fails with EPERM, EBUSY or EACCES while another process (an antivirus scan, the search
// indexer, an editor) has the target open; replaceFile retries those with a short backoff.

export type Rename = (from: string, to: string) => Promise<void>;

export interface ReplaceFileOptions {
  attempts?: number;
  delayMs?: number;
  rename?: Rename;
  sleep?: (ms: number) => Promise<void>;
}

export const replaceFile = async (
  _from: string,
  _to: string,
  _options: ReplaceFileOptions = {},
): Promise<void> => {
  throw new Error('not implemented');
};
