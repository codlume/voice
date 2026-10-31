import { createRoot } from "react-dom/client";

import "./style.css";
import { startRendererDiagnostics } from "./diagnostics.ts";
import { Notepad } from "./MeetingNotepad.tsx";

startRendererDiagnostics();

createRoot(document.getElementById("root")!).render(<Notepad />);
