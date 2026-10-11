// Spoken phrases that Voice finds inside dictated text: snippet triggers and dictionary entries.

// A trigger's identity among snippets: case, punctuation, symbols, and spacing never tell two
// triggers apart. Also how a dictation that is only a trigger is recognised.
export const phraseKey = (text: string) => text.toLowerCase().replace(/[\p{P}\p{S}\p{Z}\s]/gu, "");

// Letters that do not decompose, such as Ł, keep their shape.
export const withoutAccents = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "");

// What the rewrite pass treats as one phrase: case, accents, and runs of whitespace never tell two
// phrases apart, punctuation does, so "e-mail" and "email" are different phrases.
export const matchKey = (text: string) =>
  withoutAccents(text).toLowerCase().trim().split(/\s+/u).join(" ");

// A dictionary phrase and a snippet trigger that are the same phrase would shadow each other, so
// both pages refuse the second one. Loading a settings file keeps such a pair.
export const samePhrase = (a: string, b: string) => matchKey(a) === matchKey(b);
