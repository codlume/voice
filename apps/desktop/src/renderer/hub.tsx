import { createRoot } from "react-dom/client";

import "./style.css";
import { startRendererDiagnostics } from "./diagnostics.ts";
import { HubShell } from "./HubShell.tsx";
import { useHistory } from "./useHistory.ts";
import { useSnapshot } from "./useSnapshot.ts";

function Hub() {
  const snapshot = useSnapshot();
  const history = useHistory();
  return snapshot && history ? <HubShell snapshot={snapshot} history={history} /> : null;
}

startRendererDiagnostics();

createRoot(document.getElementById("root")!).render(<Hub />);
