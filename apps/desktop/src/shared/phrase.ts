// Letters that do not decompose, such as Ł, keep their shape.
export const withoutAccents = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "");

// What the rewrite pass treats as one phrase: case, accents, and runs of whitespace never tell two
// phrases apart, punctuation does, so "e-mail" and "email" are different phrases.
export const matchKey = (text: string) =>
  withoutAccents(text).toLowerCase().trim().split(/\s+/u).join(" ");

export const samePhrase = (a: string, b: string) => matchKey(a) === matchKey(b);
