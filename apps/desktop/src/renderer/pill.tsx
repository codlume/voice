import { createRoot } from "react-dom/client";

import "./style.css";
import { startRendererDiagnostics } from "./diagnostics.ts";
import { PillCapsule } from "./PillCapsule.tsx";
import { useSnapshot } from "./useSnapshot.ts";

function Pill() {
  const snapshot = useSnapshot();
  return (
    <PillCapsule
      session={snapshot?.session ?? { kind: "idle" }}
      alwaysShowPill={snapshot?.settings.alwaysShowPill ?? true}
    />
  );
}

startRendererDiagnostics();

createRoot(document.getElementById("root")!).render(<Pill />);
