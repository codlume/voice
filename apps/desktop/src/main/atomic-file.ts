import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

const pending = new Map<string, Promise<void>>();

export function writeFileAtomic(
  file: string,
  text: string,
  options: { mode?: number } = {},
): Promise<void> {
  const write = (pending.get(file) ?? Promise.resolve()).then(() => replace(file, text, options));
  const settled = write.catch(() => {});
  pending.set(file, settled);
  void settled.then(() => {
    if (pending.get(file) === settled) pending.delete(file);
  });
  return write;
}

async function replace(file: string, text: string, options: { mode?: number }) {
  await mkdir(NodePath.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    // Without the flush, a power loss can land the rename before the data and leave an empty file.
    await writeFile(temp, text, { flush: true, ...options });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}
