import * as stylex from "@stylexjs/stylex";
import { CircleAlertIcon, CircleUserRoundIcon, Trash2Icon, UserRoundXIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ACCOUNT_NAME_MAX_LENGTH, type AccountName, type AccountState } from "../shared/api.ts";
import { accountName, accountRow } from "./accountView.ts";
import { Avatar, AvatarSpinner } from "./Avatar.tsx";
import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { HiddenEmail } from "./HiddenEmail.tsx";
import { GoogleIcon } from "./Icons.tsx";
import { Input } from "./Input.tsx";
import { pageStyles } from "./pageStyles.ts";
import { useHoldNavigation } from "./navigationHold.ts";
import { Section, styles as settings } from "./settingsParts.tsx";
import { color, leading, radius, space, text } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";
import { hubApi } from "./voice.ts";

const markSize = 40;

// Adapted sign-in card (MIT, see THIRD_PARTY_NOTICES.md): a 40px mark beside a name and a muted
// status line with one action on the right, a tinted strip for the pasted code, and a red-tinted
// card for an error.
const styles = stylex.create({
  mark: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    width: markSize,
    height: markSize,
    borderRadius: radius.round,
    backgroundColor: color.muted,
    color: color.mutedForeground,
  },
  // A row that leads with a mark keeps the mark close to its text.
  markRow: { gap: space.md },
  errorMark: { backgroundColor: color.errorSurface, color: color.errorForeground },
  errorCard: { borderColor: `color-mix(in srgb, ${color.error} 40%, transparent)` },
  identity: { display: "flex", flexDirection: "column", gap: 2, flexGrow: 1, minWidth: 0 },
  name: {
    overflow: "hidden",
    fontSize: text.sm,
    fontWeight: 500,
    lineHeight: leading.sm,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  signedInAs: {
    display: "flex",
    alignItems: "center",
    gap: space.xxs,
    minWidth: 0,
    color: color.mutedForeground,
    fontSize: text.xs,
    lineHeight: leading.xs,
  },
  waitingText: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space.xs,
    flexGrow: 1,
    minWidth: 0,
  },
  strip: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    paddingBlock: space.md,
    paddingInline: space.base,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: `color-mix(in srgb, ${color.border} 50%, transparent)`,
    borderBottomLeftRadius: `calc(${radius.large} - 1px)`,
    borderBottomRightRadius: `calc(${radius.large} - 1px)`,
    backgroundColor: `color-mix(in srgb, ${color.muted} 40%, transparent)`,
  },
  stripEnd: { justifyContent: "flex-end" },
  field: { width: 224, flexShrink: 0 },
  codeField: { flexGrow: 1, minWidth: 0 },
});

type RowRole = "status" | "alert";
const rowRoles: Partial<Record<AccountState["kind"], RowRole>> = {
  signingIn: "status",
  error: "alert",
};

function RowText({ account }: { account: Exclude<AccountState, { kind: "signedIn" }> }) {
  const role = rowRoles[account.kind];
  const { title, detail } = accountRow(account);
  return (
    <div
      role={role}
      aria-live={role === "status" ? "polite" : undefined}
      {...stylex.props(settings.rowText)}
    >
      <span {...stylex.props(settings.rowTitle)}>{title}</span>
      <p {...stylex.props(settings.rowDetail)}>{detail}</p>
    </div>
  );
}

function Mark({ error = false, children }: { error?: boolean; children: ReactNode }) {
  return (
    <span aria-hidden {...stylex.props(styles.mark, error && styles.errorMark)}>
      {children}
    </span>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    message && (
      <p role="alert" {...stylex.props(pageStyles.error, settings.note)}>
        {message}
      </p>
    )
  );
}

function SignedOutRow({ account }: { account: Extract<AccountState, { kind: "signedOut" }> }) {
  const { pending, error, run } = useAction();
  return (
    <>
      <Card>
        <div {...stylex.props(settings.row, styles.markRow)}>
          <Mark>
            <CircleUserRoundIcon size={20} />
          </Mark>
          <RowText account={account} />
          <Button
            id="setting-sign-in"
            variant="secondary"
            disabled={pending}
            onClick={() => void run(() => hubApi().signIn(), "Could not start signing in.")}
          >
            <GoogleIcon width={16} height={16} />
            Sign in with Google
          </Button>
        </div>
      </Card>
      <ErrorLine message={error} />
    </>
  );
}

function SigningInRow({ account }: { account: Extract<AccountState, { kind: "signingIn" }> }) {
  const { pending, error, run, clearError } = useAction();
  const [pasting, setPasting] = useState(false);
  const [code, setCode] = useState("");
  const pastedCode = code.trim();
  const submitCode = () => {
    if (!pastedCode || pending) return;
    void run(() => hubApi().submitSignInCode(pastedCode), "Could not check the code.");
  };
  return (
    <>
      <Card>
        <div {...stylex.props(settings.row, styles.markRow)}>
          <AvatarSpinner size={markSize} />
          <div {...stylex.props(styles.waitingText)}>
            <RowText account={account} />
            {!pasting && (
              <Button variant="text" onClick={() => setPasting(true)}>
                Paste a code instead
              </Button>
            )}
          </div>
          <Button
            variant="secondary"
            disabled={account.purpose === "deleteAccount" && account.phase === "finishing"}
            onClick={() => void run(() => hubApi().cancelSignIn(), "Could not cancel signing in.")}
          >
            Cancel sign-in
          </Button>
        </div>
        {pasting && (
          <div {...stylex.props(styles.strip)}>
            <span {...stylex.props(styles.codeField)}>
              <Input
                id="setting-sign-in-code"
                aria-label="Sign-in code"
                autoComplete="off"
                autoFocus
                spellCheck={false}
                placeholder="Paste the code from the browser"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                  clearError();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) submitCode();
                }}
              />
            </span>
            <Button disabled={!pastedCode || pending} onClick={submitCode}>
              Continue
            </Button>
          </div>
        )}
      </Card>
      <ErrorLine message={error} />
    </>
  );
}

function NameField({
  id,
  label,
  value,
  disabled,
  readOnly,
  onChange,
  onEnter,
}: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  readOnly: boolean;
  onChange: (value: string) => void;
  onEnter: () => void;
}) {
  return (
    <div {...stylex.props(settings.row, disabled && settings.disabled)}>
      <label htmlFor={id} {...stylex.props(settings.rowText, settings.rowTitle)}>
        {label}
      </label>
      <span {...stylex.props(styles.field)}>
        <Input
          id={id}
          value={value}
          maxLength={ACCOUNT_NAME_MAX_LENGTH}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          readOnly={readOnly}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) onEnter();
          }}
        />
      </span>
    </div>
  );
}

function SignedInRow({ account }: { account: Extract<AccountState, { kind: "signedIn" }> }) {
  const { pending, error, run, clearError } = useAction();
  const deletion = account.deletion;
  const [draft, setDraft] = useState<AccountName | null>(null);
  const shown = draft ?? account;
  const name = { firstName: shown.firstName.trim(), lastName: shown.lastName.trim() };
  const changed = name.firstName !== account.firstName || name.lastName !== account.lastName;
  const canSave = !pending && deletion === undefined && changed && name.firstName !== "";
  useHoldNavigation(changed);
  const edit = (patch: Partial<AccountName>) => {
    setDraft({ firstName: shown.firstName, lastName: shown.lastName, ...patch });
    clearError();
  };
  const save = () => {
    if (!canSave) return;
    void run(async () => {
      await hubApi().updateAccountName(name);
      setDraft(null);
    }, "Could not save your name.");
  };
  const cancelDeletion = () =>
    void run(() => hubApi().cancelAccountDeletion(), "Could not cancel deletion.");
  return (
    <>
      <Card>
        <div {...stylex.props(settings.row, styles.markRow)}>
          <Avatar identity={account} size={markSize} />
          <div {...stylex.props(styles.identity)}>
            <span {...stylex.props(styles.name)}>{accountName(account)}</span>
            <span {...stylex.props(styles.signedInAs)}>
              Signed in as <HiddenEmail email={account.email} />
            </span>
          </div>
          <Button
            id="setting-sign-out"
            variant="secondary"
            disabled={pending || deletion !== undefined}
            onClick={() => void run(() => hubApi().signOut(), "Could not sign out.")}
          >
            Sign out
          </Button>
        </div>
        {account.notice && (
          <p role="status" {...stylex.props(styles.strip, settings.rowDetail)}>
            {account.notice}
          </p>
        )}
      </Card>

      <Section label="Profile">
        <Card>
          <NameField
            id="setting-first-name"
            label="First name"
            value={shown.firstName}
            disabled={deletion !== undefined}
            readOnly={pending}
            onChange={(firstName) => edit({ firstName })}
            onEnter={save}
          />
          <NameField
            id="setting-last-name"
            label="Last name"
            value={shown.lastName}
            disabled={deletion !== undefined}
            readOnly={pending}
            onChange={(lastName) => edit({ lastName })}
            onEnter={save}
          />
          <div {...stylex.props(styles.strip, styles.stripEnd)}>
            <Button id="setting-save-name" disabled={!canSave} onClick={save}>
              Save
            </Button>
          </div>
        </Card>
        <ErrorLine message={error} />
      </Section>

      <Section label="Danger">
        <Card>
          <div {...stylex.props(settings.row)}>
            <div {...stylex.props(settings.rowText)}>
              <span {...stylex.props(settings.rowTitle)}>Delete account</span>
              <p {...stylex.props(settings.rowDetail)}>
                Permanently deletes your Voice account and signs you out. You can create a new,
                empty account by signing in again.
              </p>
            </div>
            <Button
              id="setting-delete-account"
              variant="ghostDestructive"
              disabled={pending || deletion !== undefined}
              onClick={() =>
                void run(
                  () => hubApi().requestAccountDeletion(),
                  "Could not start deleting your account.",
                )
              }
            >
              <Trash2Icon size={16} aria-hidden />
              {deletion?.kind === "deleting" ? "Deleting…" : "Delete account"}
            </Button>
          </div>
          {(deletion?.kind === "reauthRequired" || deletion?.kind === "reauthFailed") && (
            <div {...stylex.props(settings.row)}>
              <p role="alert" {...stylex.props(settings.rowText, settings.rowDetail)}>
                {deletion.message}
              </p>
              <div {...stylex.props(settings.actions)}>
                <Button
                  disabled={pending}
                  onClick={() => void run(() => hubApi().signIn(), "Could not start signing in.")}
                >
                  {deletion.kind === "reauthFailed" ? "Retry" : "Sign in again"}
                </Button>
                <Button variant="secondary" disabled={pending} onClick={cancelDeletion}>
                  Cancel deletion
                </Button>
              </div>
            </div>
          )}
          {deletion?.kind === "revoking" && (
            <div role="status" {...stylex.props(settings.row, settings.rowDetail)}>
              Ending your previous sign-in…
            </div>
          )}
          {(deletion?.kind === "failed" || deletion?.kind === "revocationFailed") && (
            <div {...stylex.props(settings.row)}>
              <p role="alert" {...stylex.props(settings.rowText, pageStyles.error)}>
                {deletion.message}
              </p>
              <div {...stylex.props(settings.actions)}>
                <Button
                  disabled={pending}
                  onClick={() =>
                    void run(() => hubApi().retryAccountDeletion(), "Could not retry deletion.")
                  }
                >
                  Retry
                </Button>
                <Button variant="secondary" disabled={pending} onClick={cancelDeletion}>
                  Cancel deletion
                </Button>
              </div>
            </div>
          )}
        </Card>
      </Section>

      <ConfirmDialog
        open={deletion?.kind === "confirming"}
        onOpenChange={(open) => {
          if (!open) cancelDeletion();
        }}
        title="Delete your Voice account?"
        description={`This permanently deletes the Voice account for ${account.email} and signs you out. You can create a new, empty account by signing in again.`}
        actions={[
          {
            label: "Delete account",
            variant: "destructive",
            onClick: () =>
              void run(() => hubApi().confirmAccountDeletion(), "Could not delete your account."),
          },
        ]}
      />
    </>
  );
}

function ErrorRow({ account }: { account: Extract<AccountState, { kind: "error" }> }) {
  const { pending, error, run } = useAction();
  return (
    <>
      <Card style={styles.errorCard}>
        <div {...stylex.props(settings.row, styles.markRow)}>
          <Mark error>
            <CircleAlertIcon size={20} />
          </Mark>
          <RowText account={account} />
          <div {...stylex.props(settings.actions)}>
            <Button
              disabled={pending}
              onClick={() => void run(() => hubApi().signIn(), "Could not start signing in.")}
            >
              Retry
            </Button>
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() =>
                void run(() => hubApi().dismissAccountError(), "Could not dismiss the error.")
              }
            >
              Dismiss
            </Button>
          </div>
        </div>
      </Card>
      <ErrorLine message={error} />
    </>
  );
}

function AccountRow({ account }: { account: AccountState }) {
  switch (account.kind) {
    case "unavailable": {
      const { title, detail } = accountRow(account);
      return (
        <Card>
          <EmptyState icon={<UserRoundXIcon size={20} />} title={title} description={detail} />
        </Card>
      );
    }
    case "signedOut":
      return <SignedOutRow account={account} />;
    case "signingIn":
      return <SigningInRow account={account} />;
    case "signedIn":
      return <SignedInRow key={account.email} account={account} />;
    case "error":
      return <ErrorRow account={account} />;
    default: {
      const exhaustive: never = account;
      return exhaustive;
    }
  }
}

export function AccountSettings({ account }: { account: AccountState }) {
  return (
    <div {...stylex.props(settings.page)}>
      <AccountRow account={account} />
    </div>
  );
}
