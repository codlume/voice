import { useRender } from "@base-ui/react/use-render";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { emailDecoy } from "./accountView.ts";
import { radius } from "./tokens.stylex.ts";

const reducedMotion = "@media (prefers-reduced-motion: reduce)";

const styles = stylex.create({
  button: {
    display: "block",
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
  // The span's own overflow does not clip its blur, so the halo stays soft at the edges.
  text: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    transitionProperty: "filter",
    transitionDuration: { default: "150ms", [reducedMotion]: "0s" },
  },
  hidden: { filter: "blur(4px)", userSelect: "none" },
});

// The button styles sit on the default element, not in the props below, because Base UI joins
// classNames as strings and would break a render element's className function, like Menu.Item's.
export function HiddenEmail({
  email,
  render = <button type="button" {...stylex.props(styles.button)} />,
}: {
  email: string;
  render?: useRender.RenderProp;
}) {
  // Remembering which email was revealed hides a different account's email without a remount.
  const [revealedFor, setRevealedFor] = useState<string | null>(null);
  const revealed = revealedFor === email;
  return useRender({
    render,
    props: {
      "aria-label": revealed ? undefined : "Show email",
      title: revealed ? "Click to hide email" : "Click to reveal email",
      onClick: () => setRevealedFor(revealed ? null : email),
      // Blurring the clickable element itself would blur its focus outline too.
      children: (
        <span {...stylex.props(styles.text, !revealed && styles.hidden)}>
          {revealed ? email : emailDecoy(email)}
        </span>
      ),
    },
  });
}
