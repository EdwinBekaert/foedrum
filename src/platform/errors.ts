// Reading a thrown value, which may be anything: an Error, a string, a node:sqlite error.

/** What a thrown value says: an Error's message, or any other value's `String()`. */
export const messageOf = (_error: unknown): string => {
  throw new Error('not implemented');
};

/** The `code` a thrown value carries as a string (`ENOENT`, `EPERM`), or undefined. */
export const errorCode = (_error: unknown): string | undefined => {
  throw new Error('not implemented');
};

/** The SQLite result code a node:sqlite error carries in `errcode`, or undefined. */
export const sqliteErrorCode = (_error: unknown): number | undefined => {
  throw new Error('not implemented');
};
