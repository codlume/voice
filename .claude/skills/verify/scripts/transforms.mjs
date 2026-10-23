export const TRANSFORM_PARAGRAPH =
  "So um the quarterly garden club newsletter is basically ready, and we should send it to the volunteers on Friday morning. Uh, please check that the seed swap date and the new watering rota are both listed near the top.";

export function parseTransformFlags(flags) {
  let target = "electron";
  let keycode = 18;
  let escape = false;
  for (const flag of flags) {
    const [name, value] = flag.split(/=(.*)/s);
    if (name === "--target" && ["electron", "textedit"].includes(value)) target = value;
    else if (name === "--target") throw new Error("--target must be electron or textedit");
    else if (name === "--shortcut" && /^\d{1,3}$/.test(value) && Number(value) <= 127)
      keycode = Number(value);
    else if (name === "--shortcut")
      throw new Error("--shortcut must be a macOS virtual keycode from 0 to 127, such as 18 for 1");
    else if (flag === "--escape") escape = true;
    else throw new Error(`unknown flag ${flag}; use --target=, --shortcut=, or --escape`);
  }
  return { target, keycode, escape };
}

export function optionShortcutTransform(transforms, keycode) {
  if (!transforms.enabled)
    throw new Error("Transforms are off; turn them on in the Transforms page first");
  const onOption = transforms.items.filter(
    ({ shortcut }) => shortcut?.modifiers.length === 1 && shortcut.modifiers[0] === "option",
  );
  const item = onOption.find(({ shortcut }) => shortcut.keycode === keycode);
  if (!item)
    throw new Error(
      `no transform is on Option with keycode ${keycode}; Option shortcuts: ${JSON.stringify(onOption.map(({ name, shortcut }) => ({ name, keycode: shortcut.keycode })))}`,
    );
  return item;
}

export function transformLogLine(text) {
  for (const raw of text.split("\n")) {
    const at = raw.search(/\btransform \S+ outcome=\S/);
    if (at === -1) continue;
    const line = raw.slice(at).trim();
    const [, id, ...pairs] = line.split(/\s+/);
    const fields = { id };
    for (const pair of pairs) {
      const [key, value] = pair.split(/=(.*)/s);
      if (value === undefined) continue;
      fields[key] = /^\d+$/.test(value) ? Number(value) : value;
    }
    return { line, fields };
  }
  return null;
}

export const shouldEscape = (escape, sessionKind) => escape && sessionKind === "transforming";

export function resolveOutcome(finished, logged) {
  if (finished.session.kind === "transformDone")
    return { outcome: finished.session.outcome ?? null, outcomeFrom: "pill" };
  if (logged) return { outcome: { kind: logged.fields.outcome }, outcomeFrom: "log" };
  return { outcome: null, outcomeFrom: null };
}

export const freshLast = (last, pressedAt) => (last && last.finishedAt >= pressedAt ? last : null);

export const expectedLanding = (outcome, lastTransform) =>
  outcome?.kind === "inserted" && lastTransform ? lastTransform.after : null;

export const pillSummary = (run, finished) => ({
  sawTransforming: run.some((s) => s.session.kind === "transforming"),
  sawLoading: run.some((s) => s.session.kind === "transforming" && s.session.loading),
  sawTransformDone: finished.session.kind === "transformDone",
});
