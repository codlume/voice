export const dictationLanguages = [
  { value: "en", label: "English" },
  { value: "auto", label: "Auto-detect" },
  { value: "bg", label: "Bulgarian" },
  { value: "hr", label: "Croatian" },
  { value: "cs", label: "Czech" },
  { value: "da", label: "Danish" },
  { value: "nl", label: "Dutch" },
  { value: "et", label: "Estonian" },
  { value: "fi", label: "Finnish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "el", label: "Greek" },
  { value: "hu", label: "Hungarian" },
  { value: "it", label: "Italian" },
  { value: "lv", label: "Latvian" },
  { value: "lt", label: "Lithuanian" },
  { value: "mt", label: "Maltese" },
  { value: "pl", label: "Polish" },
  { value: "pt", label: "Portuguese" },
  { value: "ro", label: "Romanian" },
  { value: "ru", label: "Russian" },
  { value: "sk", label: "Slovak" },
  { value: "sl", label: "Slovenian" },
  { value: "es", label: "Spanish" },
  { value: "sv", label: "Swedish" },
  { value: "uk", label: "Ukrainian" },
] as const;

export type DictationLanguage = (typeof dictationLanguages)[number]["value"];

export function parseDictationLanguage(value: unknown): DictationLanguage {
  return dictationLanguages.find((language) => language.value === value)?.value ?? "en";
}

export function supportsCleanup(language: DictationLanguage): boolean {
  return language === "en";
}

export function wantsCleanup(settings: {
  dictationLanguage: DictationLanguage;
  cleanup: { enabled: boolean };
}): boolean {
  return settings.cleanup.enabled && supportsCleanup(settings.dictationLanguage);
}
