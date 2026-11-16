// What contacts does with an exported address book: plain data in, plain data out.

/** The contact of a line's `fields`: its name, phone and city, in that order. */
export function contactOf(fields) {
  const [name = '', phone = '', city = ''] = fields;
  return { name, phone, city };
}

/** The fields of an exported `line`, split at its commas; a field between double quotes keeps its commas, without the quotes. */
export function splitLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else field += char;
  }
  fields.push(field);
  return fields;
}
