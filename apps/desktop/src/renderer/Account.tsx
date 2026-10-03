import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import type { AccountState } from "../shared/api.ts";
import { accountRow, actionErrorMessage, initials, signInCode } from "./accountView.ts";
import { Button } from "./Button.tsx";
import { Section, styles as settings } from "./Settings.tsx";
import { color, radius, space } from "./tokens.stylex.ts";

const styles = stylex.create({
  avatar: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 40,
    height: 40,
    borderRadius: radius.round,
    backgroundColor: `color-mix(in srgb, ${color.primary} 14%, transparent)`,
    color: color.primary,
    fontSize: 15,
    fontWeight: 600,
    letterSpacing: "0.02em",
  },
  fallback: { flexDirection: "column", alignItems: "stretch", gap: space.sm },
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

function RowText({
  title,
  detail,
  role,
}: {
  title: string;
  detail: string;
  role: RowRole | undefined;
}) {
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

function AccountCard({ account }: { account: AccountState }) {
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const { title, detail } = accountRow(account);
  const pastedCode = signInCode(code);

  async function run(action: () => Promise<void>, fallback: string) {
    setError("");
    setPending(true);
    try {
      await action();
    } catch (caught) {
      setError(actionErrorMessage(caught, fallback));
    } finally {
      setPending(false);
    }
  }

  const signIn = () => void run(() => window.voice.signIn(), "Could not start signing in.");
  const submitCode = () => {
    if (pastedCode === null || pending) return;
    void run(() => window.voice.submitSignInCode(pastedCode), "Could not check the code.");
  };
  const errorLine = error && (
    <p role="alert" {...stylex.props(settings.error)}>
      {error}
    </p>
  );

  return (
    <Section label="Google sign-in">
      <div {...stylex.props(settings.card)}>
        <div {...stylex.props(settings.row)}>
          {account.kind === "signedIn" && (
            <span aria-hidden="true" {...stylex.props(styles.avatar)}>
              {initials(account.name, account.email)}
            </span>
          )}
          <RowText title={title} detail={detail} role={rowRoles[account.kind]} />
          {account.kind === "signedOut" && (
            <Button id="setting-sign-in" disabled={pending} onClick={signIn}>
              Sign in with Google
            </Button>
          )}
          {account.kind === "error" && (
            <div {...stylex.props(settings.actions)}>
              <Button disabled={pending} onClick={signIn}>
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
          )}
        </div>
        {account.kind === "signingIn" && (
          <div {...stylex.props(settings.row, styles.fallback)}>
            <p {...stylex.props(settings.rowDetail)}>
              If Voice does not come back on its own, paste the code shown in the browser.
            </p>
            <div {...stylex.props(styles.codeLine)}>
              <input
                id="setting-sign-in-code"
                aria-label="Sign-in code"
                autoComplete="off"
                spellCheck={false}
                placeholder="Paste the code from the browser"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                  setError("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) submitCode();
                }}
                {...stylex.props(styles.codeInput)}
              />
              <Button disabled={pastedCode === null || pending} onClick={submitCode}>
                Continue
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  void run(() => window.voice.cancelSignIn(), "Could not cancel signing in.")
                }
              >
                Cancel sign-in
              </Button>
            </div>
            {errorLine}
          </div>
        )}
      </div>
      {account.kind !== "signingIn" && errorLine}
    </Section>
  );
}

export function AccountSettings({ account }: { account: AccountState }) {
  return (
    <div {...stylex.props(settings.page)}>
      <h1 {...stylex.props(settings.headline)}>Account</h1>
      {/* A new state starts clean: no leftover pasted code or action error. */}
      <AccountCard key={account.kind} account={account} />
    </div>
  );
}
