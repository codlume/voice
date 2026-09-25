import type { VoiceApi } from "../shared/api.ts";

declare global {
  interface Window {
    voice: VoiceApi;
  }
}
