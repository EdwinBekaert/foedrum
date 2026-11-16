// What shelf does with a list of books: plain data in, plain data out.

/** `books` with `book` added at the end. */
export function addBook(books, book) {
  return [...books, book];
}
