import { createRoot } from "react-dom/client";

import "./style.css";
import { startRendererDiagnostics } from "./diagnostics.ts";
import { PillCapsule } from "./PillCapsule.tsx";
import { useSnapshot } from "./useSnapshot.ts";

function Pill() {
  const snapshot = useSnapshot();
  return snapshot ? (
    <PillCapsule session={snapshot.session} alwaysShowPill={snapshot.settings.alwaysShowPill} />
  ) : null;
}

startRendererDiagnostics();

createRoot(document.getElementById("root")!).render(<Pill />);
