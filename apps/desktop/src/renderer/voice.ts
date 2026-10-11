import type { HubApi, PillApi } from "../shared/api.ts";

export function hubApi(): HubApi {
  const api = window.voice;
  if ("getSnapshot" in api) return api;
  throw new Error("This page is not the Voice window.");
}

export function pillApi(): PillApi {
  const api = window.voice;
  if ("getPillSnapshot" in api) return api;
  throw new Error("This page is not the Flow Bar.");
}
