Split a line of the exported address book

The phone exports its address book as text, one contact a line: the name, the phone number and the city, separated by commas. A field that holds a comma itself, such as a name written `"Smith, Jo"`, is put between double quotes.

## What to build

- [ ] `splitLine(line)` in `src/contacts.mjs` returns a line's fields in order, a field left empty as `''`
- [ ] a test of `splitLine`
