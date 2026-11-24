import { Menu } from "@base-ui/react/menu";
import * as stylex from "@stylexjs/stylex";
import { UserIcon } from "lucide-react";
import { useRef } from "react";

import type { AccountState } from "../shared/api.ts";
import { accountName } from "./accountView.ts";
import { Avatar } from "./Avatar.tsx";
import { transitionHidden } from "./ConfirmDialog.tsx";
import { HiddenEmail } from "./HiddenEmail.tsx";
import { surfaces } from "./surfaces.ts";
import { titlebar } from "./titlebar.ts";
import { color, leading, radius, space, text } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";
import { hubApi } from "./voice.ts";

const buttonLabels: Record<Exclude<AccountState["kind"], "unavailable" | "signedIn">, string> = {
  signedOut: "Account, signed out",
  signingIn: "Account, signing in",
  error: "Account, sign-in failed",
};

const styles = stylex.create({
  open: { backgroundColor: color.accent, color: color.foreground },
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
    padding: space.xxs,
    // Electron's drag hit-testing ignores z-index, so a popup over the titlebar opts out itself.
    WebkitAppRegion: "no-drag",
  },
  header: { display: "flex", alignItems: "center", gap: space.md, padding: space.sm },
  identity: { display: "flex", flexDirection: "column", minWidth: 0 },
  name: { fontWeight: 600 },
  email: {
    alignSelf: "flex-start",
    maxWidth: "calc(100% + 8px)",
    marginInline: -4,
    paddingInline: space.xxs,
    borderRadius: radius.xs,
    color: color.mutedForeground,
    fontSize: text.xs,
    lineHeight: leading.xs,
    cursor: "pointer",
    outline: "none",
  },
  truncate: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  error: {
    margin: 0,
    paddingBlock: space.xxs,
    paddingInline: space.sm,
    color: color.errorForeground,
    fontSize: text.xs,
    lineHeight: leading.xs,
  },
});

const itemClassName = ({ highlighted, disabled }: Menu.Item.State) =>
  stylex.props(
    surfaces.item,
    highlighted && surfaces.itemHighlighted,
    disabled && surfaces.itemDisabled,
  ).className;

const emailClassName = ({ highlighted }: Menu.Item.State) =>
  stylex.props(styles.email, highlighted && surfaces.itemHighlighted).className;

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
  const title = accountName(account);
  const label = `Account, ${title}`;
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
        <UserIcon size={18} />
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
                surfaces.popup,
                surfaces.popupMotion,
                styles.popup,
                transitionHidden(transitionStatus) && surfaces.popupHidden,
              ).className
            }
          >
            <div {...stylex.props(styles.header)}>
              <Avatar identity={account} size={48} />
              <div {...stylex.props(styles.identity)}>
                <span {...stylex.props(styles.name, styles.truncate)}>{title}</span>
                <HiddenEmail
                  email={account.email}
                  render={<Menu.Item closeOnClick={false} className={emailClassName} />}
                />
              </div>
            </div>
            <Menu.Separator {...stylex.props(surfaces.separator)} />
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
                void run(() => hubApi().signOut(), "Could not sign out.");
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
      <UserIcon size={18} />
      {account.kind === "error" && <span aria-hidden="true" {...stylex.props(styles.errorDot)} />}
    </button>
  );
}
