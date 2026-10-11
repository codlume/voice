// Spoken phrases that Voice finds inside dictated text: snippet triggers and dictionary entries.

// Letters that do not decompose, such as Ł, keep their shape.
export const withoutAccents = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "");

// What the rewrite pass treats as one phrase: case, accents, and runs of whitespace never tell two
// phrases apart, punctuation does, so "e-mail" and "email" are different phrases.
export const matchKey = (text: string) =>
  withoutAccents(text).toLowerCase().trim().split(/\s+/u).join(" ");

// Two phrases the rewrite pass could not tell apart would shadow each other, so both pages refuse
// the second one, within a list and across the two. Loading a settings file keeps such a pair.
export const samePhrase = (a: string, b: string) => matchKey(a) === matchKey(b);
