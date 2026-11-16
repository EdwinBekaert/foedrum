// What rooms does with a day's bookings: plain data in, plain data out. Its codes are docs/errors.md.

export const ROOMS = ['Attic', 'Garden', 'Library'];

const isHour = (hour) => Number.isInteger(hour) && hour >= 0 && hour <= 24;

/** `{ ok: true, bookings }` with `request` added to `bookings`, or `{ ok: false, code }`. */
export function book(bookings, request) {
  if (!ROOMS.includes(request.room)) return { ok: false, code: 'UNKNOWN_ROOM' };
  if (!isHour(request.from) || !isHour(request.to) || request.from >= request.to) {
    return { ok: false, code: 'BAD_HOURS' };
  }
  return { ok: true, bookings: [...bookings, request] };
}
