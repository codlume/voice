import * as stylex from "@stylexjs/stylex";
import { createRoot } from "react-dom/client";

import "./style.css";
import { tokens } from "./tokens.stylex.ts";
import { useSnapshot } from "./useSnapshot.ts";

const styles = stylex.create({
  page: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: "100vh",
    backgroundColor: tokens.background,
    color: tokens.ink,
    fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
  },
  title: { margin: 0, fontSize: 28, fontWeight: 600 },
  hint: { margin: 0, fontSize: 13, color: tokens.muted },
});

function Hub() {
  const snapshot = useSnapshot();
  return (
    <main {...stylex.props(styles.page)}>
      <h1 {...stylex.props(styles.title)}>Voice</h1>
      <p {...stylex.props(styles.hint)}>
        {snapshot ? `Hold ${snapshot.settings.hotkey} and speak` : ""}
      </p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Hub />);
