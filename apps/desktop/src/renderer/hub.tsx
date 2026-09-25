import { createRoot } from "react-dom/client";

import "./style.css";
import { HubShell } from "./HubShell.tsx";
import { useSnapshot } from "./useSnapshot.ts";

function Hub() {
  const snapshot = useSnapshot();
  return snapshot ? <HubShell snapshot={snapshot} /> : null;
}

createRoot(document.getElementById("root")!).render(<Hub />);
