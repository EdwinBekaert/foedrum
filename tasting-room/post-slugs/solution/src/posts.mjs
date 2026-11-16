// What posts does with a post: plain data in, plain data out.

const WORDS_A_MINUTE = 200;

/** The minutes it takes to read `body`, at least one. */
export function readingMinutes(body) {
  const words = body.split(/\s+/).filter((word) => word !== '').length;
  return Math.max(1, Math.ceil(words / WORDS_A_MINUTE));
}

/** A post's address from its `title`: its words, runs of letters and digits, in lower case and joined by hyphens. */
export function slugOf(title) {
  return (title.toLowerCase().match(/[a-z0-9]+/g) ?? []).join('-');
}
