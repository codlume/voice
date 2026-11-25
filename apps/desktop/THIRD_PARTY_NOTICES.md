# Third-party notices

Voice's desktop interface adapts design values and component code from the projects below. Voice is not affiliated with or endorsed by any of them. Voice uses none of their names, logos, icons or other brand assets in its interface.

## T3 Code

Source: https://github.com/pingdotgg/t3code at commit `e9b227b0212d5e3e61d8da02567e23ecb69284ec`.

What Voice adapts:

- Design tokens from [`apps/web/src/index.css`](https://github.com/pingdotgg/t3code/blob/e9b227b0212d5e3e61d8da02567e23ecb69284ec/apps/web/src/index.css): the light and dark colour palettes, the indigo primary, glass and backdrop fills, shadows, radii, the type scale and the font stacks. They live in [`src/renderer/tokens.stylex.ts`](src/renderer/tokens.stylex.ts).
- Component styling from [`apps/web/src/components/ui/`](https://github.com/pingdotgg/t3code/tree/e9b227b0212d5e3e61d8da02567e23ecb69284ec/apps/web/src/components/ui), ported from Tailwind to StyleX:
  - `button`, `switch`, `badge`, `kbd`, `select`, `menu`, `popover`, `tooltip`, `dialog` and its shared dialog styles;
  - `input`, `toggle-group` and `toggle`, `skeleton`, `progress`, `empty` and `scroll-area`.
  - In Voice they are `Button`, `Switch`, `Badge`, `Keycap`, `Select`, `Menu`, `Popover`, `tooltip.ts`, `ConfirmDialog`, `surfaces.ts`, `Input`, `ToggleGroup`, `Skeleton`, `EmptyState` and `ScrollArea`.
- The warning variant of `badge`, for the "Not inserted" mark on a history row in [`src/renderer/History.tsx`](src/renderer/History.tsx). The Home setup checklist in [`src/renderer/SetupChecklist.tsx`](src/renderer/SetupChecklist.tsx) uses the ported `progress` bar.
- On the Insights page in [`src/renderer/Insights.tsx`](src/renderer/Insights.tsx): the `popover` for the info buttons, the `ghost` icon `button` styling they use, the `progress` bar for the usage bars, and the settings text weights (500 for labels, 600 for numbers).
- On the Style page in [`src/renderer/Style.tsx`](src/renderer/Style.tsx) and [`src/renderer/StyleAssignments.tsx`](src/renderer/StyleAssignments.tsx): the provider option card from [`apps/web/src/components/settings/AddProviderInstanceDialog.tsx`](https://github.com/pingdotgg/t3code/blob/e9b227b0212d5e3e61d8da02567e23ecb69284ec/apps/web/src/components/settings/AddProviderInstanceDialog.tsx) for the writing-style cards, the outline `badge` for the app chips, the `toggle-group` look for the category tabs, and the `menu` rows and `input` in the app picker.
- On the Transforms page in [`src/renderer/Transforms.tsx`](src/renderer/Transforms.tsx) and [`src/renderer/TransformFields.tsx`](src/renderer/TransformFields.tsx): the settings rows for the transform list, the `input` and [`textarea`](https://github.com/pingdotgg/t3code/blob/e9b227b0212d5e3e61d8da02567e23ecb69284ec/apps/web/src/components/ui/textarea.tsx) fields in the editor, and the `ghost-destructive` `button` for **Delete transform**, which Voice draws in the destructive color at rest. The `ghostDestructive` variant lives in [`src/renderer/Button.tsx`](src/renderer/Button.tsx).
- On the Snippets and Dictionary pages in [`src/renderer/RecordList.tsx`](src/renderer/RecordList.tsx), [`src/renderer/Snippets.tsx`](src/renderer/Snippets.tsx), [`src/renderer/Dictionary.tsx`](src/renderer/Dictionary.tsx) and [`src/renderer/SnippetEditor.tsx`](src/renderer/SnippetEditor.tsx): the settings rows with hover-revealed `ghost` icon actions, the secondary `badge` for "Off", the `input` field frame and invalid ring for every editor field, and the `toggle` and `tooltip` look for the snippet editor's formatting toolbar.
- On the Meetings page and the meeting notepad in [`src/renderer/Meetings.tsx`](src/renderer/Meetings.tsx), [`src/renderer/MeetingList.tsx`](src/renderer/MeetingList.tsx), [`src/renderer/MeetingDetail.tsx`](src/renderer/MeetingDetail.tsx), [`src/renderer/MeetingParts.tsx`](src/renderer/MeetingParts.tsx) and [`src/renderer/MeetingNotepad.tsx`](src/renderer/MeetingNotepad.tsx): the segmented `toggle-group` look for the tabs, the `menu` for the folder and More actions menus, the `skeleton` rows while meetings and transcripts load, the `empty` state, the ghost icon `button` with its `tooltip`, the warning tint of `badge` for meeting prompts and notices, and the list row spacing and hover fill.
- The Flow Bar in [`src/renderer/PillCapsule.tsx`](src/renderer/PillCapsule.tsx): the processing label's shine, a stepped transform sweep adapted from `live-activity-focus` in [`apps/web/src/index.css`](https://github.com/pingdotgg/t3code/blob/e9b227b0212d5e3e61d8da02567e23ecb69284ec/apps/web/src/index.css); pausing that animation while the page is hidden, from [`apps/web/src/lib/visibleAnimation.ts`](https://github.com/pingdotgg/t3code/blob/e9b227b0212d5e3e61d8da02567e23ecb69284ec/apps/web/src/lib/visibleAnimation.ts); and the capsule shadow, scaled down from the dark overlay shadow of [`menu`](https://github.com/pingdotgg/t3code/blob/e9b227b0212d5e3e61d8da02567e23ecb69284ec/apps/web/src/components/ui/menu.tsx) and [`popover`](https://github.com/pingdotgg/t3code/blob/e9b227b0212d5e3e61d8da02567e23ecb69284ec/apps/web/src/components/ui/popover.tsx).
- The settings page layout (section labels, rows and row text) from [`apps/web/src/components/settings/`](https://github.com/pingdotgg/t3code/tree/e9b227b0212d5e3e61d8da02567e23ecb69284ec/apps/web/src/components/settings). It lives in [`src/renderer/settingsParts.tsx`](src/renderer/settingsParts.tsx). The General, System, Models and Shortcuts pages follow it: no page headline under the modal title, section labels in line with the row text, and 160px row selects.
- The Account and Data and Privacy settings pages in [`src/renderer/Account.tsx`](src/renderer/Account.tsx) and [`src/renderer/DataPrivacySettings.tsx`](src/renderer/DataPrivacySettings.tsx) follow the same layout. The account card (a 40px mark beside the name and a muted status line, one action on the right, a tinted strip for the pasted code, and a red-tinted card for an error) is adapted from [`apps/web/src/components/settings/SourceControlAppSignInSettings.tsx`](https://github.com/pingdotgg/t3code/blob/e9b227b0212d5e3e61d8da02567e23ecb69284ec/apps/web/src/components/settings/SourceControlAppSignInSettings.tsx); the "Danger" section from [`apps/web/src/components/settings/ProjectSettingsPanel.tsx`](https://github.com/pingdotgg/t3code/blob/e9b227b0212d5e3e61d8da02567e23ecb69284ec/apps/web/src/components/settings/ProjectSettingsPanel.tsx); and the "unavailable" `empty` state inside a settings card from [`apps/web/src/components/settings/ProviderSettingsPanel.tsx`](https://github.com/pingdotgg/t3code/blob/e9b227b0212d5e3e61d8da02567e23ecb69284ec/apps/web/src/components/settings/ProviderSettingsPanel.tsx).
- Turning transitions off while a theme change paints, adapted from [`apps/web/src/hooks/useTheme.ts`](https://github.com/pingdotgg/t3code/blob/e9b227b0212d5e3e61d8da02567e23ecb69284ec/apps/web/src/hooks/useTheme.ts) and the `no-transitions` rule in [`apps/web/src/index.css`](https://github.com/pingdotgg/t3code/blob/e9b227b0212d5e3e61d8da02567e23ecb69284ec/apps/web/src/index.css). It lives in [`src/renderer/SystemSettings.tsx`](src/renderer/SystemSettings.tsx) and [`src/renderer/style.css`](src/renderer/style.css).
- The app shell from [`apps/web/src/components/ui/sidebar.tsx`](https://github.com/pingdotgg/t3code/blob/e9b227b0212d5e3e61d8da02567e23ecb69284ec/apps/web/src/components/ui/sidebar.tsx) and [`apps/web/src/components/AppRouteModal.tsx`](https://github.com/pingdotgg/t3code/blob/e9b227b0212d5e3e61d8da02567e23ecb69284ec/apps/web/src/components/AppRouteModal.tsx): the sidebar width, nav rows, inset main panel and the settings modal frame. They live in [`src/renderer/HubShell.tsx`](src/renderer/HubShell.tsx).
- The topbar height and traffic-light position from [`apps/desktop/src/window/DesktopWindow.ts`](https://github.com/pingdotgg/t3code/blob/e9b227b0212d5e3e61d8da02567e23ecb69284ec/apps/desktop/src/window/DesktopWindow.ts). They live in [`src/shared/titlebar.ts`](src/shared/titlebar.ts).
- The scrollbar, focus ring and drag-region rules in [`src/renderer/style.css`](src/renderer/style.css).

```text
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## shadcn/ui and coss ui

T3 Code's `components/ui` layer builds on components from these registries. Their licences apply to the parts of that code Voice adapts.

- shadcn/ui, https://github.com/shadcn-ui/ui: MIT License, Copyright (c) 2023 shadcn.
- coss ui, https://github.com/cosscom/ui: MIT License, Copyright (c) 2025 coss.com and Origin UI.

The MIT permission notice above applies to both, with their own copyright lines.
