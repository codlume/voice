import { join, isAbsolute } from "node:path";

export function dataDirectory(
  appData: string,
  mode: "development" | "test" | "production",
  testDirectory?: string,
) {
  if (mode === "test") {
    if (!testDirectory || !isAbsolute(testDirectory))
      throw new Error("Tests require an absolute isolated data directory");
    return join(testDirectory, "Voice Test");
  }
  return join(appData, mode === "development" ? "Voice Development" : "Voice");
}
