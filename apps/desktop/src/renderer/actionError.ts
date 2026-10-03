/**
 * `ipcRenderer.invoke` wraps a main-process rejection as
 * "Error invoking remote method '<channel>': Error: <message>". This returns the message.
 * The other Settings and Updates error blocks still show the wrapper; see
 * https://github.com/codlume/voice/issues/167.
 */
export function actionErrorMessage(caught: unknown, fallback: string): string {
  if (!(caught instanceof Error)) return fallback;
  return caught.message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, "");
}
