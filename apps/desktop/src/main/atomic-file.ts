import { mkdir, rename, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

export async function writeFileAtomic(file: string, text: string): Promise<void> {
  await mkdir(NodePath.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  // Without the flush, a power loss can land the rename before the data and leave an empty file.
  await writeFile(temp, text, { flush: true });
  await rename(temp, file);
}
