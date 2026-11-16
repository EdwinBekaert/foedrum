# The shelf file

A shelf file is JSON: a list of books, each an object with these fields and no others.

| Field | Type | Required | What it holds |
|---|---|---|---|
| `title` | string | yes | The book's title. |
| `author` | string | yes | Who wrote it. |
| `read` | boolean | no | Whether it has been read; false when left out. |

This page is the one description of the format: every field `parseShelf` accepts is listed here, and a field it does not list is refused.
