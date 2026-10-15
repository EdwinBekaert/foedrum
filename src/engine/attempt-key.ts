// The canonical text of an attempt: the `attemptKey` of its lease (ADR 0026), so the supervisor can
// tell which attempt a lease holds.

/** One attempt of a step of a batch. */
export interface AttemptRef {
  batchId: string;
  stepId: string;
  attempt: number;
}

const encode = (_ref: AttemptRef): string => {
  throw new Error('not implemented');
};

const decode = (_text: string): AttemptRef | undefined => {
  throw new Error('not implemented');
};

export const attemptKey = {
  /** The JSON array `[batchId, stepId, attempt]`; throws when a part is invalid. */
  encode,
  /** The attempt of a canonical text, or `undefined` for any other text. */
  decode,
};
