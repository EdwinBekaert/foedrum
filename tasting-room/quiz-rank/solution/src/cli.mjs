// node src/cli.mjs <command> <file> ...: quiz's commands, as docs/commands.md lists them.

import { readFileSync, writeFileSync } from 'node:fs';
import { addScore, ranking, teams } from './quiz.mjs';

const [command, file, ...rest] = process.argv.slice(2);
const load = () => JSON.parse(readFileSync(file, 'utf8'));

switch (command) {
  case 'add': {
    const [team, points] = rest;
    writeFileSync(file, `${JSON.stringify(addScore(load(), { team, points: Number(points) }))}\n`);
    break;
  }
  case 'teams':
    for (const team of teams(load())) console.log(team);
    break;
  case 'rank':
    for (const { team, points } of ranking(load())) console.log(`${points} ${team}`);
    break;
  default:
    console.error('usage: node src/cli.mjs add|teams|rank <file> ...');
    process.exitCode = 2;
}
