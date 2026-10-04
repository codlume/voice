import { Menu } from "@base-ui/react/menu";
import * as stylex from "@stylexjs/stylex";
import { useRef } from "react";

import type { AccountState } from "../shared/api.ts";
import { accountRow } from "./accountView.ts";
import { Avatar } from "./Avatar.tsx";
import { titlebar } from "./titlebar.ts";
import { color, font, radius, space } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";

const buttonLabels: Record<Exclude<AccountState["kind"], "unavailable" | "signedIn">, string> = {
  signedOut: "Account, signed out",
  signingIn: "Account, signing in",
  error: "Account, sign-in failed",
};

const reducedMotion = "@media (prefers-reduced-motion: reduce)";

const styles = stylex.create({
  open: { backgroundColor: color.sidebarRowHover },
  errorDot: {
    position: "absolute",
    top: 3,
    right: 3,
    width: 8,
    height: 8,
    borderWidth: 1.5,
    borderStyle: "solid",
    borderColor: color.sidebar,
    borderRadius: radius.round,
    backgroundColor: color.error,
  },
  positioner: { zIndex: 10 },
  popup: {
    width: "16rem",
    maxWidth: "var(--available-width)",
    padding: 4,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.medium,
    backgroundColor: color.card,
    color: color.foreground,
    boxShadow: "0 8px 24px rgb(0 0 0 / 12%)",
    fontFamily: font.sans,
    fontSize: 13,
    lineHeight: 1.45,
    WebkitFontSmoothing: "antialiased",
    outline: "none",
    WebkitAppRegion: "no-drag",
    opacity: 1,
    transitionProperty: "opacity",
    transitionDuration: { default: "150ms", [reducedMotion]: "0s" },
  },
  popupHidden: { opacity: 0 },
  header: { display: "flex", alignItems: "center", gap: 10, padding: space.sm },
  identity: { display: "flex", flexDirection: "column", minWidth: 0 },
  name: { fontWeight: 600 },
  email: { color: color.mutedForeground, fontSize: 12 },
  truncate: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  separator: { height: 1, marginBlock: 4, backgroundColor: color.border },
  item: {
    display: "flex",
    alignItems: "center",
    minHeight: 30,
    paddingBlock: 5,
    paddingInline: space.sm,
    borderRadius: radius.small,
    cursor: "pointer",
    userSelect: "none",
    outline: "none",
  },
  highlighted: { backgroundColor: color.input },
  disabled: { color: color.mutedForeground, cursor: "default" },
  error: {
    margin: 0,
    paddingBlock: 4,
    paddingInline: space.sm,
    color: color.errorForeground,
    fontSize: 12,
  },
});

function UserIcon() {
  return (
    <svg
      aria-hidden="true"
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function SignedInMenu({
  account,
  onOpenAccount,
  onSignOut,
}: {
  account: Extract<AccountState, { kind: "signedIn" }>;
  onOpenAccount: () => void;
  onSignOut: () => void;
}) {
  const { pending, error, run, clearError } = useAction();
  // The menu moves focus while it closes, so Account opens only after it has closed.
  const openAccountOnClose = useRef(false);
  const { title, detail } = accountRow(account);
  const label = `Account, ${title}`;
  const itemClassName = ({ highlighted, disabled }: Menu.Item.State) =>
    stylex.props(styles.item, highlighted && styles.highlighted, disabled && styles.disabled)
      .className;
  return (
    <Menu.Root
      onOpenChange={(open) => {
        if (!open) return;
        clearError();
        openAccountOnClose.current = false;
      }}
      onOpenChangeComplete={(open) => {
        if (open || !openAccountOnClose.current) return;
        openAccountOnClose.current = false;
        onOpenAccount();
      }}
    >
      <Menu.Trigger
        aria-label={label}
        title={label}
        className={({ open }) => stylex.props(titlebar.button, open && styles.open).className}
      >
        <UserIcon />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          {...stylex.props(styles.positioner)}
        >
          <Menu.Popup
            finalFocus={!pending}
            className={({ transitionStatus }) =>
              stylex.props(
                styles.popup,
                (transitionStatus === "starting" || transitionStatus === "ending") &&
                  styles.popupHidden,
              ).className
            }
          >
            <div {...stylex.props(styles.header)}>
              <Avatar identity={account} size={48} />
              <div {...stylex.props(styles.identity)}>
                <span {...stylex.props(styles.name, styles.truncate)}>{title}</span>
                <span {...stylex.props(styles.email, styles.truncate)}>{detail}</span>
              </div>
            </div>
            <Menu.Separator {...stylex.props(styles.separator)} />
            <Menu.Item
              onClick={() => {
                openAccountOnClose.current = true;
              }}
              className={itemClassName}
            >
              Manage account
            </Menu.Item>
            <Menu.Item
              closeOnClick={false}
              disabled={pending || account.deletion !== undefined}
              onClick={() => {
                onSignOut();
                void run(() => window.voice.signOut(), "Could not sign out.");
              }}
              className={itemClassName}
            >
              Sign out
            </Menu.Item>
            {error && (
              <p role="alert" {...stylex.props(styles.error)}>
                {error}
              </p>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function TitlebarAccount({
  account,
  onOpenAccount,
}: {
  account: AccountState;
  onOpenAccount: () => void;
}) {
  // Signing out unmounts the menu with its trigger, so the menu leaves focus alone and the
  // button that replaces the trigger takes it.
  const focusAfterSignOut = useRef(false);
  if (account.kind === "unavailable") return null;
  if (account.kind === "signedIn") {
    return (
      <SignedInMenu
        account={account}
        onOpenAccount={onOpenAccount}
        onSignOut={() => {
          focusAfterSignOut.current = true;
        }}
      />
    );
  }
  const label = buttonLabels[account.kind];
  return (
    <button
      ref={(button) => {
        if (!button || !focusAfterSignOut.current) return;
        focusAfterSignOut.current = false;
        button.focus();
      }}
      type="button"
      aria-label={label}
      title={label}
      onClick={onOpenAccount}
      {...stylex.props(titlebar.button)}
    >
      <UserIcon />
      {account.kind === "error" && <span aria-hidden="true" {...stylex.props(styles.errorDot)} />}
    </button>
  );
}
