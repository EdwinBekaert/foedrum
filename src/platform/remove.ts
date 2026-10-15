// Robust removal of files and folders (architecture §13, file locks). On Windows a folder can
// carry the ReadOnly attribute and a file can be held open briefly by another process (an
// editor, an antivirus scan, a process whose working directory is inside the folder), so a
// plain delete fails with EPERM, EBUSY or ENOTEMPTY. removeTree clears the read-only bits and
// retries those errors with a short exponential backoff before giving up.

export type RemovePath = (path: string) => Promise<void>;
export type Sleep = (ms: number) => Promise<void>;

export interface RemoveTreeOptions {
  attempts?: number;
  delayMs?: number;
  removePath?: RemovePath;
  sleep?: Sleep;
}

export const clearReadOnly = async (_path: string): Promise<void> => {
  throw new Error('not implemented');
};

export const removeTree = async (
  _path: string,
  _options: RemoveTreeOptions = {},
): Promise<void> => {
  throw new Error('not implemented');
};
