// What a person should look at before merging (ADR 0384): the changes of a kind they should always
// see, found once at the push by fixed checks on the change's files and manifests, never by a
// model, and shown as one line of the merge brief. It informs only: nothing reads it to block.

/** A file's text at a commit, or why it could not be read; `undefined` when there is none. */
export type FileAt = { text: string } | { unread: string } | undefined;
