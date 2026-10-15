import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

export async function writeFileAtomic(
  file: string,
  text: string,
  options: { mode?: number } = {},
): Promise<void> {
  await mkdir(NodePath.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    // Without the flush, a power loss can land the rename before the data and leave an empty file.
    await writeFile(temp, text, { flush: true, ...options });
    await rename(temp, file);
  } catch (error) {
    // A temp file that stays behind would keep the contents the caller meant to replace or drop.
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}
