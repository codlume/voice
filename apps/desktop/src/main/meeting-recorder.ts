import type { MeetingCommandResult, MeetingId } from "../shared/meetings.ts";

/** What drives a meeting's capture and summary. Built in later steps; until then every command is unavailable. */
export type MeetingRecorder = {
  start(): Promise<MeetingCommandResult>;
  pause(id: MeetingId): Promise<MeetingCommandResult>;
  resume(id: MeetingId): Promise<MeetingCommandResult>;
  stop(id: MeetingId): Promise<MeetingCommandResult>;
  generateSummary(id: MeetingId): Promise<MeetingCommandResult>;
};

const unavailable = async (): Promise<MeetingCommandResult> => ({ kind: "unavailable" });

export const unavailableRecorder: MeetingRecorder = {
  start: unavailable,
  pause: unavailable,
  resume: unavailable,
  stop: unavailable,
  generateSummary: unavailable,
};
