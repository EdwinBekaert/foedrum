#!/usr/bin/env node
// `foedrum`, the command-line program (ADR 0016): runs one command of the command layer against
// this machine and the Brewery in the working directory (cli-main.ts).

import { cliFromCheckout } from './cli-main.ts';

const { exitCode, stdout, stderr } = await cliFromCheckout(process.argv.slice(2), process.cwd());
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = exitCode;
