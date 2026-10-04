/**
 * `ipcRenderer.invoke` wraps a main-process rejection as
 * "Error invoking remote method '<channel>': Error: <message>". This returns the message.
 */
export function actionErrorMessage(caught: unknown, fallback: string): string {
  if (!(caught instanceof Error)) return fallback;
  return caught.message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, "");
}
