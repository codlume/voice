import type { View } from "@voice/contracts/desktop";
import type { SessionSnapshot } from "@voice/contracts/session";

// The repair action every surface offers for the current session notice or Start blocker.
export function repairAction({
  notice,
  phase,
  blocker,
}: SessionSnapshot): { view: View; label: string } | null {
  if (notice === "setup" || (phase === "idle" && blocker === "setup"))
    return { view: "setup", label: "Open Settings" };
  if (
    notice === "incomplete" ||
    notice === "not-inserted" ||
    notice === "uncertain" ||
    notice === "recovery-full" ||
    ((notice === "connection" || notice === "rate-limit") && phase === "failed") ||
    blocker === "recovery-full"
  )
    return { view: "recovery", label: "Open recovery" };
  return null;
}
