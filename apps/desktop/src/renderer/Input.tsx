import { Input as InputPrimitive } from "@base-ui/react/input";
import * as stylex from "@stylexjs/stylex";
import { SearchIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { surfaces } from "./surfaces.ts";
import { color, font, leading, space, text } from "./tokens.stylex.ts";

// Adapted input (MIT, see THIRD_PARTY_NOTICES.md): a 32px bordered field with a focus ring.
const styles = stylex.create({
  frame: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.sm,
    width: "100%",
    minWidth: 0,
  },
  search: { paddingInlineStart: 10 },
  input: {
    flexGrow: 1,
    minWidth: 0,
    height: 30,
    paddingInline: 11,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: color.foreground,
    fontFamily: font.sans,
    fontSize: text.sm,
    lineHeight: leading.sm,
    outline: "none",
    "::placeholder": { color: color.mutedForeground },
  },
  searchInput: { paddingInlineStart: 0 },
  icon: { flexShrink: 0, color: color.mutedForeground },
  disabled: { opacity: 0.64 },
});

type InputProps = Omit<ComponentProps<"input">, "className" | "style"> & {
  invalid?: boolean;
};

export function Input({ invalid = false, disabled, ...props }: InputProps) {
  return (
    <span
      {...stylex.props(
        surfaces.control,
        surfaces.field,
        invalid && surfaces.fieldInvalid,
        styles.frame,
        disabled && styles.disabled,
      )}
    >
      <InputPrimitive
        aria-invalid={invalid || undefined}
        disabled={disabled}
        {...props}
        {...stylex.props(styles.input)}
      />
    </span>
  );
}

/** A search box: a magnifier, then the field. Name it with `aria-label`. */
export function SearchField(props: Omit<InputProps, "type" | "invalid">) {
  return (
    <span
      {...stylex.props(
        surfaces.control,
        surfaces.field,
        styles.frame,
        styles.search,
        props.disabled && styles.disabled,
      )}
    >
      <SearchIcon size={16} aria-hidden {...stylex.props(styles.icon)} />
      <InputPrimitive
        type="search"
        {...props}
        {...stylex.props(styles.input, styles.searchInput)}
      />
    </span>
  );
}
