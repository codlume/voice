import { createRoot } from "react-dom/client";

import "./style.css";
import { PillCapsule } from "./PillCapsule.tsx";
import { useSnapshot } from "./useSnapshot.ts";

function Pill() {
  const snapshot = useSnapshot();
  return <PillCapsule session={snapshot?.session ?? { kind: "idle" }} />;
}

createRoot(document.getElementById("root")!).render(<Pill />);
