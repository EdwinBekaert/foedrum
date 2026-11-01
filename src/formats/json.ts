// JSON read from outside, before a schema parses it.

/** The value `text` holds, or undefined when it is not JSON. */
export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
