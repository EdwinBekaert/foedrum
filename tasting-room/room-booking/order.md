Refuse a room that is already booked

Two teams booked the same room for the same morning, and both turned up. A room that is booked must not be booked again for the same hours.

## What to build

- [ ] `book(bookings, request)` in `src/rooms.mjs` refuses a request for a room that another booking holds for at least one of the request's hours, with the code `ROOM_TAKEN`
- [ ] a test of that refusal
