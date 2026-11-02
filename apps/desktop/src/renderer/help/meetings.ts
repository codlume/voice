import type { HelpTopic } from "./types.ts";

export const meetingsHelp: HelpTopic = {
  title: "Meetings",
  summary:
    "Voice records your microphone and the sound other apps play, transcribes both as you talk, and keeps a summary when the meeting ends.",
  sections: [
    {
      heading: "Start and stop a meeting",
      body: "Press Start meeting, or the meeting shortcut (⌥M) in any app. A notepad opens beside your call and the Flow Bar shows the clock. Press Stop when you are done. Always get consent before you record other people.",
      shot: {
        file: "meetings-header",
        alt: "The top of the Meetings page with the page title, the meeting settings button and the Start meeting button.",
        scene: "meetings",
        page: "meetings",
        clip: "main div:has(> h1)",
        callouts: [
          { target: 'button[aria-label="Meeting settings"]', label: "Meeting settings" },
          { target: 'button[aria-label="Meetings help"]', label: "This help" },
          { target: "main div:has(> h1) > button:last-child", label: "Start meeting" },
        ],
      },
    },
    {
      heading: "Find a meeting",
      body: "Meetings are grouped by day, newest first. Point at a row to read its overview on the right. Search (⌘F) looks through titles, summaries, your thoughts and full transcripts.",
      shot: {
        file: "meetings-list",
        alt: "The Notes tab with meetings grouped under Today and Yesterday, and the overview panel for the selected meeting.",
        scene: "meetings",
        page: "meetings",
        clip: "main [role=tablist], main [role=tabpanel], main aside",
        callouts: [
          { target: "main [role=tablist]", label: "Past notes and Folders" },
          { target: "main [role=tablist] + div button", label: "Search" },
          { target: "main [role=tabpanel]", label: "Meetings by day" },
          { target: "main aside", label: "Overview of the meeting you point at" },
        ],
      },
    },
    {
      heading: "Inside a meeting",
      body: "Open a meeting to read its Summary, add My thoughts, or check the Transcript. Name a speaker once and the summary and export use that name. Copy as Markdown or export a .md file from the meeting's menu.",
    },
    {
      heading: "Folders",
      body: "Put a meeting in a folder from its row menu, or turn on Automatic folders to file meetings whose title contains a word you choose. Deleting a folder keeps its meetings.",
    },
  ],
};
