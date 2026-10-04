import * as stylex from "@stylexjs/stylex";
import { useState, type ReactNode } from "react";

import type { AccountState } from "../shared/api.ts";
import { accountRow } from "./accountView.ts";
import { Avatar, AvatarSpinner } from "./Avatar.tsx";
import { Button } from "./Button.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Section, styles as settings } from "./Settings.tsx";
import { color, radius, space } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";

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
});

type RowRole = "status" | "alert";
const rowRoles: Partial<Record<AccountState["kind"], RowRole>> = {
  signingIn: "status",
  error: "alert",
};

function RowText({ account }: { account: AccountState }) {
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

function Card({ children }: { children: ReactNode }) {
  return <div {...stylex.props(settings.card)}>{children}</div>;
}

function ErrorLine({ text }: { text: string }) {
  return (
    text && (
      <p role="alert" {...stylex.props(settings.error)}>
        {text}
      </p>
    )
  );
}

function SignedOutRow({ account }: { account: AccountState }) {
  const { pending, error, run } = useAction();
  return (
    <>
      <Card>
        <div {...stylex.props(settings.row)}>
          <RowText account={account} />
          <Button
            id="setting-sign-in"
            disabled={pending}
            onClick={() => void run(() => window.voice.signIn(), "Could not start signing in.")}
          >
            Sign in with Google
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
    void run(() => window.voice.submitSignInCode(pastedCode), "Could not check the code.");
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
            onClick={() =>
              void run(() => window.voice.cancelSignIn(), "Could not cancel signing in.")
            }
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

function SignedInRow({ account }: { account: Extract<AccountState, { kind: "signedIn" }> }) {
  const { pending, error, run } = useAction();
  const deletion = account.deletion;
  return (
    <>
      <Card>
        <div {...stylex.props(settings.row)}>
          <Avatar identity={account} size={40} />
          <RowText account={account} />
          <div {...stylex.props(settings.actions)}>
            <Button
              id="setting-sign-out"
              variant="secondary"
              disabled={pending || deletion !== undefined}
              onClick={() => void run(() => window.voice.signOut(), "Could not sign out.")}
            >
              Sign out
            </Button>
            <Button
              id="setting-delete-account"
              variant="destructive"
              disabled={pending || deletion !== undefined}
              onClick={() =>
                void run(
                  () => window.voice.requestAccountDeletion(),
                  "Could not start deleting your account.",
                )
              }
            >
              {deletion?.kind === "deleting" ? "Deleting…" : "Delete account"}
            </Button>
          </div>
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
                onClick={() => void run(() => window.voice.signIn(), "Could not start signing in.")}
              >
                {deletion.kind === "reauthFailed" ? "Retry" : "Sign in again"}
              </Button>
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() =>
                  void run(() => window.voice.cancelAccountDeletion(), "Could not cancel deletion.")
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
                void run(() => window.voice.retryAccountDeletion(), "Could not retry deletion.")
              }
            >
              Retry
            </Button>
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() =>
                void run(() => window.voice.cancelAccountDeletion(), "Could not cancel deletion.")
              }
            >
              Cancel deletion
            </Button>
          </div>
        )}
      </Card>
      <ErrorLine text={error} />
      <ConfirmDialog
        open={deletion?.kind === "confirming"}
        onOpenChange={(open) => {
          if (!open)
            void run(() => window.voice.cancelAccountDeletion(), "Could not cancel deletion.");
        }}
        title="Delete your Voice account?"
        description={`This permanently deletes the Voice account for ${account.email} and signs you out. You can create a new, empty account by signing in again.`}
        actions={[
          {
            label: "Delete account",
            variant: "destructive",
            onClick: () =>
              void run(
                () => window.voice.confirmAccountDeletion(),
                "Could not delete your account.",
              ),
          },
        ]}
      />
    </>
  );
}

function ErrorRow({ account }: { account: AccountState }) {
  const { pending, error, run } = useAction();
  return (
    <>
      <Card>
        <div {...stylex.props(settings.row)}>
          <RowText account={account} />
          <div {...stylex.props(settings.actions)}>
            <Button
              disabled={pending}
              onClick={() => void run(() => window.voice.signIn(), "Could not start signing in.")}
            >
              Retry
            </Button>
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() =>
                void run(() => window.voice.dismissAccountError(), "Could not dismiss the error.")
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
      return <SignedInRow account={account} />;
    case "error":
      return <ErrorRow account={account} />;
    default: {
      const exhaustive: never = account;
      return exhaustive;
    }
  }
}

export function AccountSettings({
  account,
  otherChannelSignedIn,
}: {
  account: AccountState;
  otherChannelSignedIn: boolean;
}) {
  return (
    <div {...stylex.props(settings.page)}>
      <h1 {...stylex.props(settings.headline)}>Account</h1>
      <Section label="Google sign-in">
        <AccountRow account={account} />
        {otherChannelSignedIn && (
          <p {...stylex.props(settings.hint)}>
            Stable and Nightly use separate accounts, so a sign-in from the other channel does not
            apply here.
          </p>
        )}
      </Section>
    </div>
  );
}
