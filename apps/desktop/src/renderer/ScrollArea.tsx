import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { color, radius } from "./tokens.stylex.ts";

// Adapted scroll area (MIT, see THIRD_PARTY_NOTICES.md): an overlay scrollbar that shows while
// hovering or scrolling, and an optional fade at whichever edge has more content.
const fadeSize = "24px";
const edgeFade = (edge: "top" | "bottom", amount: string) =>
  `linear-gradient(to ${edge === "top" ? "bottom" : "top"}, transparent, black min(${fadeSize}, ${amount}))`;

const styles = stylex.create({
  root: { position: "relative", minHeight: 0, height: "100%", overflow: "hidden" },
  viewport: {
    height: "100%",
    maxHeight: "inherit",
    overflow: "auto",
    overscrollBehavior: "contain",
    borderRadius: "inherit",
    outline: "none",
  },
  fade: {
    maskImage: {
      default: `${edgeFade("top", "var(--scroll-area-overflow-y-start, 0px)")}, ${edgeFade("bottom", "var(--scroll-area-overflow-y-end, 0px)")}`,
      ":focus-visible": "none",
    },
    maskComposite: "intersect",
  },
  scrollbar: {
    display: "flex",
    width: 6,
    marginBlock: 4,
    marginRight: 1,
    opacity: { default: 0, ":is([data-hovering], [data-scrolling])": 1 },
    transitionProperty: "opacity",
    transitionDuration: { default: "150ms", ":is([data-hovering], [data-scrolling])": "100ms" },
    transitionDelay: { default: "300ms", ":is([data-hovering], [data-scrolling])": "0s" },
  },
  thumb: {
    flexGrow: 1,
    borderRadius: radius.round,
    backgroundColor: {
      default: color["--scrollbar-thumb"],
      ":hover": color["--scrollbar-thumb-hover"],
    },
  },
});

export function ScrollArea({ fade = false, children }: { fade?: boolean; children: ReactNode }) {
  return (
    <ScrollAreaPrimitive.Root {...stylex.props(styles.root)}>
      <ScrollAreaPrimitive.Viewport {...stylex.props(styles.viewport, fade && styles.fade)}>
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar orientation="vertical" {...stylex.props(styles.scrollbar)}>
        <ScrollAreaPrimitive.Thumb {...stylex.props(styles.thumb)} />
      </ScrollAreaPrimitive.Scrollbar>
    </ScrollAreaPrimitive.Root>
  );
}
