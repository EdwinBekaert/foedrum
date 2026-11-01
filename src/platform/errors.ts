// Reading a thrown value, which may be anything: an Error, a string, a node:sqlite error.

/** What a thrown value says: an Error's message, or any other value's `String()`. */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The `code` a thrown value carries as a string (`ENOENT`, `EPERM`), or undefined. */
export const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

/**
 * The SQLite result code a node:sqlite error carries in `errcode`, or undefined. Its `code` is
 * always `ERR_SQLITE_ERROR`, so `errorCode` cannot tell one SQLite failure from another.
 */
export const sqliteErrorCode = (error: unknown): number | undefined =>
  error instanceof Error && 'errcode' in error && typeof error.errcode === 'number'
    ? error.errcode
    : undefined;
