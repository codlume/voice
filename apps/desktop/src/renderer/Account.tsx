import * as stylex from "@stylexjs/stylex";
import { useState, type ReactNode } from "react";

import type { AccountState } from "../shared/api.ts";
import { accountRow, initials } from "./accountView.ts";
import { Button } from "./Button.tsx";
import { Section, styles as settings } from "./Settings.tsx";
import { color, radius, space } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";

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

function SigningInRow({ account }: { account: AccountState }) {
  const { pending, error, run, clearError } = useAction();
  const [code, setCode] = useState("");
  const pastedCode = code.trim();
  const submitCode = () => {
    if (!pastedCode || pending) return;
    void run(() => window.voice.submitSignInCode(pastedCode), "Could not check the code.");
  };
  return (
    <Card>
      <div {...stylex.props(settings.row)}>
        <RowText account={account} />
      </div>
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
          <Button
            variant="secondary"
            onClick={() =>
              void run(() => window.voice.cancelSignIn(), "Could not cancel signing in.")
            }
          >
            Cancel sign-in
          </Button>
        </div>
        <ErrorLine text={error} />
      </div>
    </Card>
  );
}

function SignedInRow({ account }: { account: Extract<AccountState, { kind: "signedIn" }> }) {
  const { pending, error, run } = useAction();
  return (
    <>
      <Card>
        <div {...stylex.props(settings.row)}>
          <span aria-hidden="true" {...stylex.props(styles.avatar)}>
            {initials(account.name, account.email)}
          </span>
          <RowText account={account} />
          <Button
            id="setting-sign-out"
            variant="secondary"
            disabled={pending}
            onClick={() => void run(() => window.voice.signOut(), "Could not sign out.")}
          >
            Sign out
          </Button>
        </div>
      </Card>
      <ErrorLine text={error} />
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

export function AccountSettings({ account }: { account: AccountState }) {
  return (
    <div {...stylex.props(settings.page)}>
      <h1 {...stylex.props(settings.headline)}>Account</h1>
      <Section label="Google sign-in">
        <AccountRow account={account} />
      </Section>
    </div>
  );
}
