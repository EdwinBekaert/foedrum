// A time as a person reads it (ADR 0379): `13 Nov 19:16 UTC`. Events keep the ISO form.

/** `instant`, an ISO time or a date, as `13 Nov 19:16 UTC`. */
export const whenText = (_instant: string | Date): string => {
  throw new Error('not implemented');
};
