# Working on contacts

contacts reads the address book a phone exports, one contact a line.

## Rules

- A contact is `{ name, phone, city }`, each a string, empty when the export left it out.
- Tests use `node:test` and `node:assert`, and plain data instead of files.
