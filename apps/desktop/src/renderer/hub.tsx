import { createRoot } from "react-dom/client";

import "./style.css";
import { startRendererDiagnostics } from "./diagnostics.ts";
import { HubShell } from "./HubShell.tsx";
import { useSnapshot } from "./useSnapshot.ts";

function Hub() {
  const snapshot = useSnapshot();
  return snapshot ? <HubShell snapshot={snapshot} /> : null;
}

startRendererDiagnostics();

createRoot(document.getElementById("root")!).render(<Hub />);
