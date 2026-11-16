// What shelf does with a list of books: plain data in, plain data out.

/** `books` with `book` added at the end. */
export function addBook(books, book) {
  return [...books, book];
}

/** The books of `books` that have `tag`, in the shelf's order. */
export function withTag(books, tag) {
  return books.filter((book) => (book.tags ?? []).includes(tag));
}
