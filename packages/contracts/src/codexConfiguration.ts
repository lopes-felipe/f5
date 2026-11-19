import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderInstanceId } from "./providerInstance";

const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(4096));
const NullableText = Schema.NullOr(Schema.String);
export const CodexNativeProvider = Schema.Struct({
  id: Text,
  name: Text,
  canEdit: Schema.Boolean,
  baseUrl: NullableText,
  settings: Schema.Union([
    Schema.Struct({ type: Schema.Literal("openai") }),
    Schema.Struct({
      type: Schema.Literal("customGateway"),
      auth: Schema.Union([
        Schema.Struct({ mode: Schema.Literal("none") }),
        Schema.Struct({ mode: Schema.Literal("environmentVariable"), envKey: Text }),
        Schema.Struct({ mode: Schema.Literal("externallyConfigured"), envKey: NullableText }),
      ]),
    }),
    Schema.Struct({ type: Schema.Literal("bedrock"), profile: NullableText, region: NullableText }),
    Schema.Struct({
      type: Schema.Literal("gcp"),
      projectId: NullableText,
      location: NullableText,
      credentialFile: NullableText,
    }),
  ]),
});
export type CodexNativeProvider = typeof CodexNativeProvider.Type;
export const CodexNativeProviderPatch = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("customGateway"),
    providerId: Schema.optionalKey(Schema.NullOr(Text)),
    name: Schema.optionalKey(Text),
    baseUrl: Schema.optionalKey(Schema.NullOr(Text)),
    envKey: Schema.optionalKey(Schema.NullOr(Text)),
  }),
  Schema.Struct({
    type: Schema.Literal("bedrock"),
    providerId: Schema.Literals(["amazon-bedrock", "amazon-bedrock-runtime"]),
    profile: Schema.optionalKey(Schema.NullOr(Text)),
    region: Schema.optionalKey(Schema.NullOr(Text)),
  }),
  Schema.Struct({
    type: Schema.Literal("gcp"),
    providerId: Schema.Literal("gcp"),
    projectId: Schema.optionalKey(Schema.NullOr(Text)),
    location: Schema.optionalKey(Schema.NullOr(Text)),
    credentialFile: Schema.optionalKey(Schema.NullOr(Text)),
  }),
]);
export const CodexConfigurationAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("securityRead") }),
  Schema.Struct({ type: Schema.Literal("read") }),
  Schema.Struct({ type: Schema.Literal("write"), settings: CodexNativeProviderPatch }),
  Schema.Struct({ type: Schema.Literal("setDefault"), providerId: Text }),
  Schema.Struct({
    type: Schema.Literal("setFeature"),
    feature: Schema.Literals(["audio", "animation"]),
    enabled: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("gatewayRead"), providerId: Text }),
  Schema.Struct({
    type: Schema.Literal("gatewayLogin"),
    providerId: Text,
    deviceAuth: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("gatewayCancel"), loginId: Text }),
]);
export type CodexConfigurationAction = typeof CodexConfigurationAction.Type;
export const ServerCodexConfigurationInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  action: CodexConfigurationAction,
});
export type ServerCodexConfigurationInput = typeof ServerCodexConfigurationInput.Type;
export const CodexConfigurationResult = Schema.Struct({
  providers: Schema.optional(
    Schema.Struct({
      data: Schema.Array(CodexNativeProvider),
      defaultProviderId: Text,
      canChangeDefault: Schema.Boolean,
    }),
  ),
  features: Schema.optional(Schema.Struct({ audio: Schema.Boolean, animation: Schema.Boolean })),
  securityNotice: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        accountId: Text,
        userId: Text,
        title: Text,
        description: Text,
        action: Schema.Struct({ label: Text, url: Text }),
      }),
    ),
  ),
  gateway: Schema.optional(
    Schema.Struct({
      providerId: Text,
      providerName: Text,
      required: Schema.Boolean,
      supportsDeviceAuth: Schema.optional(Schema.Boolean),
      status: NullableText,
      error: NullableText,
    }),
  ),
  login: Schema.optional(
    Schema.Struct({
      loginId: Text,
      providerId: Text,
      status: Schema.String,
      authUrl: NullableText,
      verificationUrl: NullableText,
      userCode: NullableText,
      error: NullableText,
    }),
  ),
});
export type CodexConfigurationResult = typeof CodexConfigurationResult.Type;
