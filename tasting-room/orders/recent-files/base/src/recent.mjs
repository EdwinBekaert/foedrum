// What the editor's menu shows: plain data in, plain data out.

/** The name a menu shows for `file`: the last part of its path. */
export function label(file) {
  return file.slice(file.lastIndexOf('/') + 1);
}
