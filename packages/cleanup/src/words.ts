// What counts as a word for every limit and budget the user can meet, in main, the renderer and
// the engine alike. Pure, so the renderer can import it without the engine.
export const countWords = (text: string): number => text.split(/\s+/).filter(Boolean).length;
