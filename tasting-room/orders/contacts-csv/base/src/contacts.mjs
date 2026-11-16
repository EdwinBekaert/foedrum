// What contacts does with an exported address book: plain data in, plain data out.

/** The contact of a line's `fields`: its name, phone and city, in that order. */
export function contactOf(fields) {
  const [name = '', phone = '', city = ''] = fields;
  return { name, phone, city };
}
