// Amounts in whole cents (CLAUDE.md).

/** `amount` rounded to a whole number of cents, half a cent away from zero. */
export function roundCents(amount) {
  return Math.sign(amount) * Math.round(Math.abs(amount));
}

/** `cents` as euros with two decimals, such as `12.50`. */
export function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const whole = Math.abs(cents);
  return `${sign}${Math.floor(whole / 100)}.${String(whole % 100).padStart(2, '0')}`;
}
