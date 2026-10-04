import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { emailDecoy } from "./accountView.ts";
import { radius } from "./tokens.stylex.ts";

const reducedMotion = "@media (prefers-reduced-motion: reduce)";

const styles = stylex.create({
  button: {
    maxWidth: "100%",
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: "transparent",
    color: "inherit",
    font: "inherit",
    textAlign: "start",
    cursor: "pointer",
  },
  text: {
    transitionProperty: "filter",
    transitionDuration: { default: "150ms", [reducedMotion]: "0s" },
  },
  hidden: { filter: "blur(4px)", userSelect: "none" },
});

export function HiddenEmail({ email, xstyle }: { email: string; xstyle?: stylex.StyleXStyles }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <button
      type="button"
      aria-label={revealed ? undefined : "Show email"}
      title={revealed ? "Click to hide email" : "Click to reveal email"}
      onClick={() => setRevealed(!revealed)}
      {...stylex.props(styles.button, xstyle)}
    >
      {/* Blurring the button itself would blur its focus outline too. */}
      <span {...stylex.props(styles.text, !revealed && styles.hidden)}>
        {revealed ? email : emailDecoy(email)}
      </span>
    </button>
  );
}
