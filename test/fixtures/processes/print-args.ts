// Prints its arguments as JSON, for test/integration/processes.test.ts.

process.stdout.write(JSON.stringify(process.argv.slice(2)));
