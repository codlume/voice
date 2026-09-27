import { ensureFixtures } from "../../../scripts/fixtures.mjs";
import { assert, dictateFixture, prepareAsr, withHelper } from "./helper.mjs";

ensureFixtures();

await withHelper({}, async (helper) => {
  await prepareAsr(helper);
  const results = [];
  for (const language of ["en", "auto", "ru", "en"]) {
    const { transcript } = await dictateFixture(
      helper,
      "language-trigger.wav",
      `language-${results.length}`,
      language,
    );
    const text = transcript.text;
    assert(text.trim().length > 0, `${language} returned an empty transcript`);
    const cyrillic = /\p{Script=Cyrillic}/u.test(text);
    assert(
      cyrillic === (language !== "en"),
      `${language} produced unexpected writing script: ${JSON.stringify(text)}`,
    );
    results.push({ language, text, asrMs: transcript.asrMs });
  }
  console.log(JSON.stringify(results));
});
