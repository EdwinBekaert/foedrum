// node src/cli.mjs <command> <file> ...: the shelf's commands.

import { addBook } from './shelf.mjs';
import { load, save } from './store.mjs';

const [command, file, ...rest] = process.argv.slice(2);

switch (command) {
  case 'add': {
    const [title, author] = rest;
    save(file, addBook(load(file), { title, author }));
    break;
  }
  case 'list':
    for (const book of load(file))
      console.log(`${book.read ? 'x' : ' '} ${book.title}, ${book.author}`);
    break;
  default:
    console.error('usage: node src/cli.mjs add|list <file> ...');
    process.exitCode = 2;
}
