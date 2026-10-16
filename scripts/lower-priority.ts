// Loaded with --import by npm run test:integration and by the coverage runs of /brew-review, which
// cannot load npm test's preload (it refuses process starts): lowers the process's priority
// outside CI, and every process it starts inherits it (scripts/below-normal-priority.ts, #140).
