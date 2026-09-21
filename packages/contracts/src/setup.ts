import { Schema } from "effect";

const boundedText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
export const Permission = Schema.Literals(["microphone", "accessibility", "inputMonitoring"]);
export type Permission = typeof Permission.Type;
export const permissionNames = ["microphone", "accessibility", "inputMonitoring"] as const;
export const PermissionState = Schema.Literals([
  "not-requested",
  "granted",
  "denied",
  "revoked",
  "unavailable",
]);
const Permissions = Schema.Struct({
  microphone: PermissionState,
  accessibility: PermissionState,
  inputMonitoring: PermissionState,
});
export const Binding = Schema.Literals([
  "Fn",
  "Fn+Space",
  "Escape",
  "Control+Option+Space",
  "Control+Shift+Space",
  "Control+Option+Escape",
]);
export const Shortcuts = Schema.Struct({ hold: Binding, toggle: Binding, cancel: Binding });
export const SetupPreferences = Schema.Struct({
  inputDevice: Schema.NullOr(boundedText),
  shortcuts: Shortcuts,
  completed: Schema.Boolean,
  requestedPermissions: Schema.Array(Permission),
  grantedPermissions: Schema.Array(Permission),
});
export type SetupPreferences = typeof SetupPreferences.Type;
export const defaultSetupPreferences: SetupPreferences = {
  inputDevice: null,
  shortcuts: { hold: "Fn", toggle: "Fn+Space", cancel: "Escape" },
  completed: false,
  requestedPermissions: [],
  grantedPermissions: [],
};
const Availability = Schema.Literals(["available", "conflict", "unavailable"]);
export const NativeSetupStatus = Schema.Struct({
  permissions: Permissions,
  devices: Schema.Array(Schema.Struct({ id: boundedText, name: boundedText })),
  defaultDevice: Schema.NullOr(boundedText),
  shortcuts: Schema.Struct({ hold: Availability, toggle: Availability, cancel: Availability }),
});
export type NativeSetupStatus = typeof NativeSetupStatus.Type;
export const CredentialPresence = Schema.Literals(["missing", "saved", "unavailable"]);
export const Credential = Schema.Struct({
  presence: CredentialPresence,
  verification: Schema.Literals(["unverified", "authenticated", "rejected"]),
});
export const SetupStatus = Schema.Struct({
  native: Schema.NullOr(NativeSetupStatus),
  credential: Credential,
  connectivity: Schema.Literals(["unknown", "online", "offline"]),
  provider: Schema.Literals([
    "unknown",
    "available",
    "unreachable",
    "rate-limited",
    "quota-exhausted",
  ]),
  localCapture: Schema.Literals(["available", "unavailable"]),
  blockers: Schema.Array(Schema.String),
});
export type SetupStatus = typeof SetupStatus.Type;
export const SetupCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("setup.refresh") }),
  Schema.Struct({
    type: Schema.Literal("setup.save"),
    inputDevice: Schema.NullOr(boundedText),
    shortcuts: Shortcuts,
    completed: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("permission.request"), permission: Permission }),
  Schema.Struct({
    type: Schema.Literal("credential.set"),
    key: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(512),
      Schema.isPattern(/^[\x21-\x7e]+$/),
    ),
  }),
  Schema.Struct({ type: Schema.Literal("credential.remove") }),
]);
export type SetupCommand = typeof SetupCommand.Type;
export const NativeSetupCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("setup.status"), shortcuts: Shortcuts }),
  Schema.Struct({ type: Schema.Literal("permission.request"), permission: Permission }),
  Schema.Struct({ type: Schema.Literal("credential.status") }),
  Schema.Struct({
    type: Schema.Literal("credential.set"),
    key: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(512),
      Schema.isPattern(/^[\x21-\x7e]+$/),
    ),
  }),
  Schema.Struct({ type: Schema.Literal("credential.remove") }),
]);
export type NativeSetupCommand = typeof NativeSetupCommand.Type;
export const NativeSetupResult = Schema.Union([
  Schema.Struct({ type: Schema.Literal("setup"), status: NativeSetupStatus }),
  Schema.Struct({ type: Schema.Literal("credential"), presence: CredentialPresence }),
  Schema.Struct({ type: Schema.Literal("permission") }),
  Schema.Struct({
    type: Schema.Literal("error"),
    error: Schema.Literals(["keychain-unavailable", "native-unavailable", "invalid-command"]),
  }),
]);
export type NativeSetupResult = typeof NativeSetupResult.Type;
export const CredentialChanged = Schema.Struct({
  type: Schema.Literal("credential.changed"),
  revision: Schema.Number,
  presence: CredentialPresence,
});
export type CredentialChanged = typeof CredentialChanged.Type;
export const decodeCredentialChanged = Schema.decodeUnknownSync(CredentialChanged, {
  onExcessProperty: "error",
});
export const decodeSetupCommand = Schema.decodeUnknownSync(SetupCommand, {
  onExcessProperty: "error",
});
export const decodeNativeSetupCommand = Schema.decodeUnknownSync(NativeSetupCommand, {
  onExcessProperty: "error",
});
export const decodeNativeSetupResult = Schema.decodeUnknownSync(NativeSetupResult, {
  onExcessProperty: "error",
});
