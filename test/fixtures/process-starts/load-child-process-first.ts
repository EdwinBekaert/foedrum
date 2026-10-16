// Loaded with --import before npm test's preload: node:child_process's ES module then exists before
// the preload replaces the functions, as when something imports it first (#111).
import 'node:child_process';
