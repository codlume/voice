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
- The settings page layout (section labels, rows and row text) from [`apps/web/src/components/settings/`](https://github.com/pingdotgg/t3code/tree/e9b227b0212d5e3e61d8da02567e23ecb69284ec/apps/web/src/components/settings). It lives in [`src/renderer/settingsParts.tsx`](src/renderer/settingsParts.tsx).
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
