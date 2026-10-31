/** The languages the summary has headings for. Any other transcript gets English headings. */
export const SUMMARY_LANGUAGES = {
  en: {
    name: "English",
    decisions: "Decisions",
    nextSteps: "Next Steps",
    unassigned: "Unassigned",
    words: ["the", "and", "is", "that", "we", "you", "this", "for", "with", "will", "it's", "of"],
  },
  pl: {
    name: "Polish (polski)",
    decisions: "Decyzje",
    nextSteps: "Następne kroki",
    unassigned: "Bez przypisania",
    words: ["się", "nie", "jest", "że", "na", "jak", "już", "ale", "czy", "tak", "będzie", "mamy"],
  },
  de: {
    name: "German (Deutsch)",
    decisions: "Entscheidungen",
    nextSteps: "Nächste Schritte",
    unassigned: "Nicht zugewiesen",
    words: ["und", "der", "die", "das", "ist", "nicht", "wir", "ich", "mit", "auch", "für", "eine"],
  },
  fr: {
    name: "French (français)",
    decisions: "Décisions",
    nextSteps: "Prochaines étapes",
    unassigned: "Non attribué",
    words: ["le", "la", "les", "et", "est", "pas", "nous", "que", "une", "pour", "avec", "des"],
  },
  es: {
    name: "Spanish (español)",
    decisions: "Decisiones",
    nextSteps: "Próximos pasos",
    unassigned: "Sin asignar",
    words: ["el", "los", "las", "que", "es", "y", "para", "con", "una", "pero", "por", "está"],
  },
  it: {
    name: "Italian (italiano)",
    decisions: "Decisioni",
    nextSteps: "Prossimi passi",
    unassigned: "Non assegnato",
    words: ["il", "che", "non", "è", "per", "una", "sono", "anche", "gli", "della", "ma", "questo"],
  },
  pt: {
    name: "Portuguese (português)",
    decisions: "Decisões",
    nextSteps: "Próximos passos",
    unassigned: "Não atribuído",
    words: ["o", "os", "que", "não", "é", "para", "com", "uma", "mas", "também", "você", "isso"],
  },
  nl: {
    name: "Dutch (Nederlands)",
    decisions: "Besluiten",
    nextSteps: "Volgende stappen",
    unassigned: "Niet toegewezen",
    words: ["de", "het", "een", "en", "niet", "is", "dat", "wij", "ik", "met", "ook", "voor"],
  },
} as const;

export type SummaryLanguage = keyof typeof SUMMARY_LANGUAGES;

const languages = Object.keys(SUMMARY_LANGUAGES) as SummaryLanguage[];

export const headingsFor = (language: string) =>
  SUMMARY_LANGUAGES[languages.find((known) => known === language) ?? "en"];

const SAMPLE_WORDS = 3000;

/** The language whose common words the transcript uses most; English when none stands out. */
export function detectLanguage(text: string): SummaryLanguage {
  const counts = new Map<string, number>();
  for (const word of text
    .toLocaleLowerCase()
    .match(/\p{L}+(?:'\p{L}+)?/gu)
    ?.slice(0, SAMPLE_WORDS) ?? []) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  let best: SummaryLanguage = "en";
  let bestScore = 0;
  for (const language of languages) {
    const score = SUMMARY_LANGUAGES[language].words.reduce(
      (sum, word) => sum + (counts.get(word) ?? 0),
      0,
    );
    if (score > bestScore) [best, bestScore] = [language, score];
  }
  return best;
}
