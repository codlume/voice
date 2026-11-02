import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { ACCOUNT_NAME_MAX_LENGTH, type AccountName, type AccountState } from "../shared/api.ts";
import { accountRow } from "./accountView.ts";
import { Avatar, AvatarSpinner } from "./Avatar.tsx";
import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { HiddenEmail } from "./HiddenEmail.tsx";
import { GoogleIcon } from "./Icons.tsx";
import { pageStyles } from "./pageStyles.ts";
import { styles as settings } from "./settingsParts.tsx";
import { color, radius, space } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";
import { hubApi } from "./voice.ts";

const rowHeight = 32;

const styles = stylex.create({
  waitingText: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 6,
    flexGrow: 1,
    minWidth: 0,
  },
  codeLine: { display: "flex", alignItems: "center", gap: space.sm },
  codeInput: {
    flexGrow: 1,
    minWidth: 0,
    paddingBlock: 6,
    paddingInline: 10,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: color.border, ":focus": color.input },
    borderRadius: radius.medium,
    backgroundColor: color.card,
    color: color.foreground,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 12.5,
  },
  fieldLabel: { flexGrow: 1, minWidth: 0, fontWeight: 500 },
  email: {
    display: "flex",
    alignItems: "center",
    minWidth: 0,
    minHeight: rowHeight,
    color: color.mutedForeground,
  },
  nameInput: {
    width: 240,
    paddingBlock: 6,
    paddingInline: 10,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: color.border, ":focus": color.input },
    borderRadius: radius.medium,
    backgroundColor: color.card,
    color: color.foreground,
    font: "inherit",
    fontSize: 13,
  },
  formActions: { display: "flex", alignItems: "center", gap: space.sm },
  save: { marginInlineStart: "auto" },
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

function ErrorLine({ text }: { text: string }) {
  return (
    text && (
      <p role="alert" {...stylex.props(pageStyles.error)}>
        {text}
      </p>
    )
  );
}

function SignedOutRow({ account }: { account: Extract<AccountState, { kind: "signedOut" }> }) {
  const { pending, error, run } = useAction();
  return (
    <>
      <Card>
        <div {...stylex.props(settings.row)}>
          <RowText account={account} />
          <Button
            id="setting-sign-in"
            variant="secondary"
            disabled={pending}
            onClick={() => void run(() => hubApi().signIn(), "Could not start signing in.")}
          >
            Sign in with Google
            <GoogleIcon width={16} height={16} />
          </Button>
        </div>
      </Card>
      <ErrorLine text={error} />
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
        <div {...stylex.props(settings.row)}>
          <AvatarSpinner size={40} />
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
          <div {...stylex.props(settings.row, styles.codeLine)}>
            <input
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
              {...stylex.props(styles.codeInput)}
            />
            <Button disabled={!pastedCode || pending} onClick={submitCode}>
              Continue
            </Button>
          </div>
        )}
      </Card>
      <ErrorLine text={error} />
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
      <label htmlFor={id} {...stylex.props(styles.fieldLabel)}>
        {label}
      </label>
      <input
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
        {...stylex.props(styles.nameInput)}
      />
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
  return (
    <>
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
        <div {...stylex.props(settings.row)}>
          <span {...stylex.props(styles.fieldLabel)}>Email</span>
          <span {...stylex.props(styles.email)}>
            <HiddenEmail email={account.email} />
          </span>
        </div>
        <div {...stylex.props(settings.row)}>
          <span {...stylex.props(styles.fieldLabel)}>Profile picture</span>
          <Avatar identity={account} size={rowHeight} />
        </div>
        {account.notice && (
          <p role="status" {...stylex.props(settings.row, settings.rowDetail)}>
            {account.notice}
          </p>
        )}
        {(deletion?.kind === "reauthRequired" || deletion?.kind === "reauthFailed") && (
          <div {...stylex.props(settings.row)}>
            <p role="alert" {...stylex.props(settings.rowDetail)}>
              {deletion.message}
            </p>
            <div {...stylex.props(settings.actions)}>
              <Button
                disabled={pending}
                onClick={() => void run(() => hubApi().signIn(), "Could not start signing in.")}
              >
                {deletion.kind === "reauthFailed" ? "Retry" : "Sign in again"}
              </Button>
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() =>
                  void run(() => hubApi().cancelAccountDeletion(), "Could not cancel deletion.")
                }
              >
                Cancel deletion
              </Button>
            </div>
          </div>
        )}
        {deletion?.kind === "revoking" && (
          <div role="status" {...stylex.props(settings.row)}>
            Ending your previous sign-in…
          </div>
        )}
        {(deletion?.kind === "failed" || deletion?.kind === "revocationFailed") && (
          <div {...stylex.props(settings.row)}>
            <ErrorLine text={deletion.message} />
            <Button
              disabled={pending}
              onClick={() =>
                void run(() => hubApi().retryAccountDeletion(), "Could not retry deletion.")
              }
            >
              Retry
            </Button>
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() =>
                void run(() => hubApi().cancelAccountDeletion(), "Could not cancel deletion.")
              }
            >
              Cancel deletion
            </Button>
          </div>
        )}
      </Card>
      <div {...stylex.props(styles.formActions)}>
        <Button
          id="setting-sign-out"
          variant="secondary"
          disabled={pending || deletion !== undefined}
          onClick={() => void run(() => hubApi().signOut(), "Could not sign out.")}
        >
          Sign out
        </Button>
        <Button
          id="setting-delete-account"
          variant="destructive"
          disabled={pending || deletion !== undefined}
          onClick={() =>
            void run(
              () => hubApi().requestAccountDeletion(),
              "Could not start deleting your account.",
            )
          }
        >
          {deletion?.kind === "deleting" ? "Deleting…" : "Delete account"}
        </Button>
        <div {...stylex.props(styles.save)}>
          <Button id="setting-save-name" disabled={!canSave} onClick={save}>
            Save
          </Button>
        </div>
      </div>
      <ErrorLine text={error} />
      <ConfirmDialog
        open={deletion?.kind === "confirming"}
        onOpenChange={(open) => {
          if (!open) void run(() => hubApi().cancelAccountDeletion(), "Could not cancel deletion.");
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
      <Card>
        <div {...stylex.props(settings.row)}>
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
      <ErrorLine text={error} />
    </>
  );
}

function AccountRow({ account }: { account: AccountState }) {
  switch (account.kind) {
    case "unavailable":
      return (
        <Card>
          <div {...stylex.props(settings.row)}>
            <RowText account={account} />
          </div>
        </Card>
      );
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
      <h1 {...stylex.props(pageStyles.headline)}>Account</h1>
      <AccountRow account={account} />
    </div>
  );
}
