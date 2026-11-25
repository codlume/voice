import * as stylex from "@stylexjs/stylex";

// Light and dark values are adapted under MIT, see THIRD_PARTY_NOTICES.md.
// Electron's nativeTheme.themeSource drives prefers-color-scheme from the Theme setting.
const dark = "@media (prefers-color-scheme: dark)";
const primary = { default: "oklch(0.488 0.217 264)", [dark]: "oklch(0.571 0.21 264)" };
const background = { default: "oklch(99.2% 0 0)", [dark]: "#000" };
const raised = { default: "white", [dark]: "color-mix(in srgb, oklch(14.5% 0 0) 97%, white)" };
const subtle = { default: "oklch(98.5% 0 0)", [dark]: "rgb(255 255 255 / 3%)" };
const accent = { default: "oklch(96.7% 0.001 286.375)", [dark]: "rgb(255 255 255 / 4%)" };
const input = { default: "oklch(87.1% 0.006 286.286)", [dark]: "rgb(255 255 255 / 11%)" };
const error = {
  default: "oklch(63.7% 0.237 25.331)",
  [dark]: "color-mix(in srgb, oklch(63.7% 0.237 25.331) 90%, white)",
};
const warning = "oklch(76.9% 0.188 70.08)";

export const color = stylex.defineVars({
  background,
  foreground: { default: "oklch(21% 0.006 285.885)", [dark]: "oklch(97% 0 0)" },
  card: raised,
  popover: raised,
  secondary: subtle,
  muted: subtle,
  mutedForeground: { default: "oklch(55.2% 0.016 285.938)", [dark]: "oklch(70.8% 0 0)" },
  accent,
  border: { default: "oklch(92% 0.004 286.32)", [dark]: "rgb(255 255 255 / 8%)" },
  input,
  // A control's own fill. Dark mode tints controls with the input color.
  control: { default: raised.default, [dark]: "rgb(255 255 255 / 3.5%)" },
  controlHover: { default: "oklch(96.7% 0.001 286.375 / 50%)", [dark]: "rgb(255 255 255 / 7%)" },
  segmentTrack: { default: "oklch(87.1% 0.006 286.286 / 40%)", [dark]: "rgb(255 255 255 / 4.4%)" },
  segmentSelected: { default: background.default, [dark]: "rgb(255 255 255 / 8%)" },
  primary,
  primaryForeground: "white",
  // Literal name so style.css can use var(--ring) for the global focus outline.
  "--ring": primary,
  success: "oklch(69.6% 0.17 162.48)",
  successForeground: {
    default: "oklch(50.8% 0.118 165.612)",
    [dark]: "oklch(76.5% 0.177 163.223)",
  },
  error,
  errorForeground: { default: "oklch(50.5% 0.213 27.518)", [dark]: "oklch(70.4% 0.191 22.216)" },
  errorSurface: {
    default: `color-mix(in srgb, ${error.default} 8%, transparent)`,
    [dark]: `color-mix(in srgb, ${error[dark]} 16%, transparent)`,
  },
  warning,
  warningForeground: { default: "oklch(55.5% 0.163 48.998)", [dark]: "oklch(82.8% 0.189 84.429)" },
  warningSurface: {
    default: `color-mix(in srgb, ${warning} 8%, transparent)`,
    [dark]: `color-mix(in srgb, ${warning} 16%, transparent)`,
  },
  info: "oklch(62.3% 0.214 259.815)",
  infoForeground: { default: "oklch(48.8% 0.243 264.376)", [dark]: "oklch(70.7% 0.165 254.624)" },
  backdrop: {
    default: `color-mix(in srgb, ${background.default} 60%, transparent)`,
    [dark]: `color-mix(in srgb, ${background[dark]} 64%, transparent)`,
  },
  // Dialogs, menus and popovers are frosted: a translucent fill over a backdrop blur.
  glass: {
    default: `color-mix(in srgb, ${background.default} 80%, transparent)`,
    [dark]: `color-mix(in srgb, ${background[dark]} 80%, transparent)`,
  },
  dropdownGlass: {
    default: `color-mix(in srgb, ${raised.default} 18%, color-mix(in srgb, ${raised.default} 80%, transparent))`,
    [dark]: `color-mix(in srgb, ${raised[dark]} 18%, color-mix(in srgb, ${raised[dark]} 80%, transparent))`,
  },
  glassBorder: {
    default: "color-mix(in srgb, oklch(21% 0.006 285.885) 10%, transparent)",
    [dark]: "rgb(255 255 255 / 8%)",
  },
  // Literal names so style.css can draw the native scrollbars with them.
  "--scrollbar-thumb": { default: "rgb(217 217 217)", [dark]: "rgb(255 255 255 / 36%)" },
  "--scrollbar-thumb-hover": { default: "rgb(191 191 191)", [dark]: "rgb(255 255 255 / 45%)" },
  // The sidebar is true black in dark mode, with rows tinted by its foreground.
  sidebar: { default: "oklch(98.5% 0 0)", [dark]: "#000" },
  sidebarRowHover: { default: background.default, [dark]: "rgb(241 243 247 / 8%)" },
  sidebarRowSelected: { default: "white", [dark]: "rgb(241 243 247 / 7%)" },
});

// The Flow Bar floats over other apps, so it is dark in both themes.
export const darkPill = stylex.defineVars({
  surface: "#0b0b0c",
  line: "rgba(255, 255, 255, 0.14)",
  glyph: "white",
  text: "rgba(255, 255, 255, 0.92)",
  // The base of the processing shimmer: 6.2:1 on the surface.
  muted: "rgba(255, 255, 255, 0.55)",
  hover: "rgba(255, 255, 255, 0.08)",
  recording: "#ff453a",
  attention: "#ffd60a",
  // The overlay shadow scaled to a 32px capsule. A deep negative spread, as on a large overlay,
  // collapses any shape shorter than twice the spread and draws nothing.
  elevation: "0 1px 2px rgb(0 0 0 / 30%), 0 6px 16px -4px rgb(0 0 0 / 50%)",
});

export const radius = stylex.defineVars({
  xs: "4px",
  small: "6px",
  // The control radius: buttons, inputs, selects and menus.
  medium: "8px",
  large: "12px",
  xl: "16px",
  round: "999px",
});

export const space = stylex.defineVars({
  xxs: "4px",
  xs: "6px",
  sm: "8px",
  md: "12px",
  base: "16px",
  lg: "20px",
  xl: "32px",
  xxl: "48px",
});

export const font = stylex.defineVars({
  sans: '-apple-system, BlinkMacSystemFont, "Inter Variable", "Segoe UI", system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
});

// A Tailwind-style type scale. Pair each size with the line height of the same name.
export const text = stylex.defineVars({
  xxs: "11px",
  xs: "12px",
  sm: "14px",
  base: "16px",
  lg: "18px",
  xl: "20px",
  xxl: "24px",
  xxxl: "30px",
});

export const leading = stylex.defineVars({
  xxs: "16px",
  xs: "16px",
  sm: "20px",
  base: "24px",
  lg: "28px",
  xl: "28px",
  xxl: "32px",
  xxxl: "36px",
});

const shadowXs = "0 1px 2px 0 rgb(0 0 0 / 5%)";

export const elevation = stylex.defineVars({
  // Bordered controls and cards.
  xs: shadowXs,
  sm: "0 1px 3px 0 rgb(0 0 0 / 5%), 0 1px 2px -1px rgb(0 0 0 / 5%)",
  md: "0 4px 6px -1px rgb(0 0 0 / 5%), 0 2px 4px -2px rgb(0 0 0 / 5%)",
  // The 1px inner edge drawn on a control's ::before: a shade below in light, a lit edge above in dark.
  edge: { default: "0 1px rgb(0 0 0 / 4%)", [dark]: "0 -1px rgb(255 255 255 / 6%)" },
  // Filled buttons: a lit top edge at rest, a shaded one while pressed.
  highlight: "inset 0 1px rgb(255 255 255 / 16%)",
  pressed: "inset 0 1px rgb(0 0 0 / 8%)",
  primary: `0 1px 2px 0 color-mix(in srgb, ${primary.default} 24%, transparent)`,
  popup: {
    default: "0 16px 40px -18px rgb(0 0 0 / 55%)",
    [dark]: "0 18px 44px -18px rgb(0 0 0 / 80%)",
  },
  dialog: {
    default: "0 24px 64px -24px rgb(0 0 0 / 65%)",
    [dark]: "inset 0 1px rgb(255 255 255 / 4%), 0 24px 72px -20px rgb(0 0 0 / 90%)",
  },
});

export const blur = stylex.defineConsts({
  glass: "blur(12px) saturate(1.14)",
  glassDark: "blur(16px) saturate(1.08)",
  backdrop: "blur(4px)",
});

export const motion = stylex.defineConsts({
  fast: "100ms",
  base: "150ms",
  slow: "200ms",
  ease: "cubic-bezier(0.4, 0, 0.2, 1)",
  easeOut: "cubic-bezier(0.2, 0, 0, 1)",
  drawer: "cubic-bezier(0.32, 0.72, 0, 1)",
  reduced: "@media (prefers-reduced-motion: reduce)",
  dark,
});

export const icon = stylex.defineConsts({ sm: "14px", md: "16px", lg: "18px", stroke: "1.75" });

export const snippetEditor = stylex.defineConsts({ minHeight: "174px" });

export const layout = stylex.defineConsts({ narrow: "@container (max-width: 720px)" });
