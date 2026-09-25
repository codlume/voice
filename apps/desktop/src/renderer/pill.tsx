import * as stylex from "@stylexjs/stylex";
import { createRoot } from "react-dom/client";

import "./style.css";
import { tokens } from "./tokens.stylex.ts";
import { useSnapshot } from "./useSnapshot.ts";

const styles = stylex.create({
  frame: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
    height: "100vh",
    paddingBottom: 4,
  },
  capsule: {
    width: 36,
    height: 8,
    borderRadius: 999,
    backgroundColor: tokens.pill,
    opacity: 0.6,
  },
});

function Pill() {
  const snapshot = useSnapshot();
  return (
    <div {...stylex.props(styles.frame)}>
      <div {...stylex.props(styles.capsule)} data-state={snapshot?.session.kind ?? "loading"} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Pill />);
