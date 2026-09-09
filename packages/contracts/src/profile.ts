import { Schema } from "effect";
import { IsoDateTime, makeSlugSchema, TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderInstanceId } from "./providerInstance";

export const ProfileId = TrimmedNonEmptyString.check(Schema.isPattern(/^[0-9a-f]{32}$/)).pipe(
  Schema.brand("ProfileId"),
);
export type ProfileId = typeof ProfileId.Type;
export const ProfileSlug = makeSlugSchema({ maxChars: 32, pattern: /^[a-z][a-z0-9-]*$/ });
export const ProfileStatus = Schema.Literals(["ready", "provisioning", "removing"]);
export const ProfilePort = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));
export const ProfileRecord = Schema.Struct({
  id: ProfileId,
  slug: ProfileSlug,
  name: TrimmedNonEmptyString,
  accentColor: Schema.optional(Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/))),
  port: ProfilePort,
  isDefault: Schema.Boolean,
  status: ProfileStatus,
  createdAt: IsoDateTime,
});
export type ProfileRecord = typeof ProfileRecord.Type;
export type ActiveProfile = Pick<
  ProfileRecord,
  "id" | "slug" | "name" | "accentColor" | "isDefault"
>;
export const ProfileRegistryFile = Schema.Struct({
  version: Schema.Int,
  retiredPorts: Schema.Array(ProfilePort),
  profiles: Schema.Array(ProfileRecord),
});
export type ProfileRegistryFile = typeof ProfileRegistryFile.Type;
export const ProfileRegistryDiagnostic = Schema.Struct({
  code: Schema.Literals(["unreadable", "malformed", "newer-version", "invariant-violation"]),
  message: Schema.String,
  path: Schema.String,
});
export type ProfileRegistryDiagnostic = typeof ProfileRegistryDiagnostic.Type;
export const ProfileProviderAccount = Schema.Struct({
  driver: Schema.String,
  instanceId: ProviderInstanceId,
  displayName: Schema.String,
  status: Schema.Literals(["authenticated", "unauthenticated", "unknown", "unsupported-isolation"]),
  identity: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
});
export const ProfileSummary = Schema.Struct({
  ...ProfileRecord.fields,
  stateDir: Schema.String,
  isActive: Schema.Boolean,
  providerAccounts: Schema.Array(ProfileProviderAccount),
  invalidDirectories: Schema.optional(
    Schema.Array(Schema.Struct({ directory: Schema.String, reason: Schema.String })),
  ),
  sharedRepositories: Schema.optional(
    Schema.Array(
      Schema.Struct({ workspaceRoot: Schema.String, otherProfiles: Schema.Array(Schema.String) }),
    ),
  ),
});
export type ProfileSummary = typeof ProfileSummary.Type;
export const ProfileListResult = Schema.Struct({
  profiles: Schema.Array(ProfileSummary),
  diagnostic: Schema.optional(ProfileRegistryDiagnostic),
});
export const ProfileCreateInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  accentColor: ProfileRecord.fields.accentColor,
});
export type ProfileCreateInput = typeof ProfileCreateInput.Type;
export const ProfileUpdateInput = Schema.Struct({
  profileId: ProfileId,
  name: Schema.optional(TrimmedNonEmptyString),
  accentColor: ProfileRecord.fields.accentColor,
  port: Schema.optional(ProfilePort),
});
export type ProfileUpdateInput = typeof ProfileUpdateInput.Type;
export const ProfileDeleteInput = Schema.Struct({ profileId: ProfileId });
export const ProviderAccountStartInput = Schema.Struct({ instanceId: ProviderInstanceId });
export const ProviderAccountHandleInput = Schema.Struct({ handle: TrimmedNonEmptyString });
export const ProviderAccountInput = Schema.Struct({
  handle: TrimmedNonEmptyString,
  data: Schema.String.check(Schema.isMaxLength(65536)),
});
export const ProviderAccountEvent = Schema.Struct({
  handle: Schema.String,
  instanceId: ProviderInstanceId,
  type: Schema.Literals(["output", "exited", "error"]),
  data: Schema.String,
});

export const GithubAccountInput = Schema.Struct({
  host: Schema.String.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)),
  token: TrimmedNonEmptyString,
});
export const GithubAccountHostInput = Schema.Struct({ host: GithubAccountInput.fields.host });
