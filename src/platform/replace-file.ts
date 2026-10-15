// Replacing a file by renaming another over it (architecture §13, file locks). On Windows the
// rename fails with EPERM, EBUSY or EACCES while another process (an antivirus scan, the search
// indexer, an editor) has the target open; replaceFile retries those with a short backoff.

import { rename as renameFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { errorCode } from './remove.ts';

export type Rename = (from: string, to: string) => Promise<void>;

export interface ReplaceFileOptions {
  attempts?: number;
  delayMs?: number;
  rename?: Rename;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

export const replaceFile = async (
  from: string,
  to: string,
  options: ReplaceFileOptions = {},
): Promise<void> => {
  const { attempts = 5, delayMs = 50, rename = renameFile, sleep = delay } = options;
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (attempt >= attempts || code === undefined || !RETRYABLE_CODES.has(code)) throw error;
      await sleep(delayMs * 2 ** (attempt - 1));
    }
  }
};
