// What the editor's menu shows: plain data in, plain data out.

const KEPT = 5;

/** The name a menu shows for `file`: the last part of its path. */
export function label(file) {
  return file.slice(file.lastIndexOf('/') + 1);
}

/** The files opened most recently once `file` is opened, newest first and each once, at most five. */
export function opened(recent, file) {
  return [file, ...recent.filter((other) => other !== file)].slice(0, KEPT);
}
