import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vite-plus/test";
import { openSettings } from "./settings";

it("migrates, persists an appearance preference and reopens the migrated database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-settings-"));
  const options = {
    filename: join(directory, "settings.sqlite"),
    migrations: resolve("migrations"),
  };
  try {
    const first = await openSettings(options);
    try {
      expect(await first.get()).toEqual({ appearance: "light" });
      expect(await first.set({ appearance: "dark" })).toEqual({ appearance: "dark" });
    } finally {
      await first.close();
    }
    const second = await openSettings(options);
    try {
      expect(await second.get()).toEqual({ appearance: "dark" });
    } finally {
      await second.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects a failed migration instead of returning a usable settings service", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-migration-failure-"));
  try {
    await expect(
      openSettings({
        filename: join(directory, "settings.sqlite"),
        migrations: join(directory, "missing-migrations"),
      }),
    ).rejects.toThrow();
    const repaired = await openSettings({
      filename: join(directory, "settings.sqlite"),
      migrations: resolve("migrations"),
    });
    try {
      expect(await repaired.set({ appearance: "dark" })).toEqual({ appearance: "dark" });
    } finally {
      await repaired.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
