// The page expression behind `click`, kept apart so a test can run it against a stub document.
const show = (value) => JSON.stringify(value);

export const ACCESSIBLE_NAME = `(el) => {
  const ids = el.getAttribute("aria-labelledby");
  const text = el.getAttribute("aria-label")
    ?? (ids && ids.split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" "))
    ?? (el.labels?.[0]?.textContent)
    ?? el.textContent;
  return (text ?? "").replace(/\\s+/g, " ").trim();
}`;
const CANDIDATES =
  'button, a, [role="switch"], [role="radio"], [role="option"], [role="combobox"], [role="menuitem"]';
export const visible = "(el) => el.getClientRects().length > 0";

function findExpression(target) {
  if (target.startsWith("css:")) {
    return `[...document.querySelectorAll(${show(target.slice(4))})].filter(${visible})`;
  }
  return `[...document.querySelectorAll(${show(CANDIDATES)})].filter(${visible}).filter((el) => (${ACCESSIBLE_NAME})(el) === ${show(target)})`;
}

// Resolves to { clicked } for the one enabled visible match, { ambiguous } for several, and false
// until there is exactly one. A mouse click gives the element keyboard focus before it clicks, and
// controls such as the shortcut picker record the key presses that follow, so this does the same.
export function clickExpression(target) {
  return `(() => {
    const matches = ${findExpression(target)};
    if (matches.length !== 1) return matches.length > 1 ? { ambiguous: matches.map(${ACCESSIBLE_NAME}) } : false;
    if (matches[0].disabled || matches[0].getAttribute("aria-disabled") === "true") return false;
    matches[0].focus();
    matches[0].click();
    return { clicked: (${ACCESSIBLE_NAME})(matches[0]) };
  })()`;
}
