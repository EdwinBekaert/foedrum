// A time as a person reads it (ADR 0379): `13 Nov 19:16 UTC`. Events keep the ISO form.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const twoDigits = (n: number): string => String(n).padStart(2, '0');

/** `instant`, an ISO time or a date, as `13 Nov 19:16 UTC`. */
export const whenText = (instant: string | Date): string => {
  const at = typeof instant === 'string' ? new Date(instant) : instant;
  const month = MONTHS[at.getUTCMonth()] ?? '';
  return `${at.getUTCDate()} ${month} ${twoDigits(at.getUTCHours())}:${twoDigits(at.getUTCMinutes())} UTC`;
};
