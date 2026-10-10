import { createRoot } from "react-dom/client";

import "./style.css";
import { startRendererDiagnostics } from "./diagnostics.ts";
import { PillCapsule } from "./PillCapsule.tsx";
import { usePillSnapshot } from "./useSnapshot.ts";

function Pill() {
  const snapshot = usePillSnapshot();
  return snapshot ? <PillCapsule {...snapshot} /> : null;
}

startRendererDiagnostics();

createRoot(document.getElementById("root")!).render(<Pill />);
