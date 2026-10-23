export const countWords = (text: string): number => text.split(/\s+/).filter(Boolean).length;
