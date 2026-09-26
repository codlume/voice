import * as stylex from "@stylexjs/stylex";

// t3code's semantic palette (apps/web/src/index.css), built on Tailwind v4 zinc/neutral.
// Electron's nativeTheme.themeSource drives prefers-color-scheme from the Theme setting.
const dark = "@media (prefers-color-scheme: dark)";
const primary = { default: "oklch(0.488 0.217 264)", [dark]: "oklch(0.571 0.21 264)" };

export const color = stylex.defineVars({
  background: { default: "oklch(99.2% 0 0)", [dark]: "oklch(14.5% 0 0)" },
  foreground: { default: "oklch(27.4% 0.006 286.033)", [dark]: "oklch(97% 0 0)" },
  card: { default: "white", [dark]: "color-mix(in srgb, oklch(14.5% 0 0) 97%, white)" },
  mutedForeground: {
    default: "oklch(55.2% 0.016 285.938)",
    [dark]: "color-mix(in srgb, oklch(55.6% 0 0) 90%, white)",
  },
  accent: { default: "oklch(96.7% 0.001 286.375)", [dark]: "rgb(255 255 255 / 4%)" },
  border: { default: "oklch(92% 0.004 286.32)", [dark]: "rgb(255 255 255 / 6%)" },
  input: { default: "oklch(87.1% 0.006 286.286)", [dark]: "rgb(255 255 255 / 8%)" },
  primary,
  primaryForeground: "white",
  // Literal name so style.css can use var(--ring) for the global focus outline.
  "--ring": primary,
  success: "oklch(69.6% 0.17 162.48)",
  successForeground: {
    default: "oklch(50.8% 0.118 165.612)",
    [dark]: "oklch(76.5% 0.177 163.223)",
  },
  error: {
    default: "oklch(63.7% 0.237 25.331)",
    [dark]: "color-mix(in srgb, oklch(63.7% 0.237 25.331) 90%, white)",
  },
  errorForeground: { default: "oklch(50.5% 0.213 27.518)", [dark]: "oklch(70.4% 0.191 22.216)" },
  sidebar: {
    default: "oklch(98.5% 0 0)",
    [dark]: "color-mix(in srgb, oklch(14.5% 0 0) 97%, white)",
  },
  sidebarRowHover: { default: "oklch(96.7% 0.001 286.375)", [dark]: "rgb(255 255 255 / 4%)" },
  sidebarRowSelected: { default: "white", [dark]: "rgb(255 255 255 / 3%)" },
});

// The pill floats over other apps, so it stays dark in both themes.
export const pillColor = stylex.defineVars({
  surface: "#0b0b0c",
  line: "rgba(255, 255, 255, 0.14)",
  glyph: "white",
  text: "rgba(255, 255, 255, 0.92)",
});

export const radius = stylex.defineVars({
  small: "6px",
  medium: "10px",
  large: "14px",
  round: "999px",
});

export const space = stylex.defineVars({
  sm: "8px",
  md: "12px",
  lg: "20px",
  xl: "32px",
  xxl: "48px",
});

export const font = stylex.defineVars({
  sans: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
  serif: 'ui-serif, "New York", "Iowan Old Style", Charter, Georgia, serif',
});
