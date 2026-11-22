/**
 * Allowlisted projection of an Antigravity live capture (R0).
 *
 * Captures run against a real `agy acp` and may see account identity, paths, prompt text and
 * `_meta` payloads. Only the fields below are ever committed as fixtures: mode IDs, option IDs and
 * values, command names, permission kinds and field presence. Everything else is dropped.
 */

export const ANTIGRAVITY_CAPTURE_FIXTURE_VERSION = 1 as const;

export interface AntigravityCaptureMeta {
  readonly agyVersion: string;
  readonly platform: string;
  readonly authMethod: string;
  readonly accountTier: string;
  /** Calendar date only (YYYY-MM-DD). */
  readonly capturedOn: string;
  /** Present when the fixture was derived from upstream T3 Code rather than captured live. */
  readonly upstream?: { readonly commit: string; readonly file: string };
}

export interface AntigravityPermissionSample {
  readonly step: string;
  readonly sessionMode: string;
  readonly request: unknown;
}

/** Raw capture as collected by `acp-capability-probe.ts`. Never committed. */
export interface AntigravityCaptureRaw {
  readonly initialize?: unknown;
  readonly helpText?: string;
  readonly session?: {
    readonly modes?: unknown;
    readonly configOptions?: unknown;
    readonly commands?: ReadonlyArray<unknown>;
  };
  readonly models?: ReadonlyArray<{ readonly id: string; readonly configOptions: unknown }>;
  readonly permissions?: ReadonlyArray<AntigravityPermissionSample>;
  readonly usageFrames?: ReadonlyArray<unknown>;
  readonly promptResponses?: ReadonlyArray<unknown>;
  readonly resume?: {
    readonly ok: boolean;
    readonly response?: unknown;
    readonly modelBefore?: string;
  };
  readonly steer?: {
    readonly secondPromptAccepted: boolean;
    readonly stopReasons: ReadonlyArray<unknown>;
  };
  readonly backgroundWake?: { readonly updatesAfterPromptResponse: ReadonlyArray<unknown> };
  readonly stopResend?: { readonly firstStopReason?: unknown; readonly secondStopReason?: unknown };
  readonly checks?: {
    readonly defaultModelPersistsAfterCycling?: boolean | null;
    readonly defaultRestoredInFreshProcess?: boolean | null;
    readonly apiKeyVisibleToShell?: boolean | null;
    readonly apiKeyVisibleToMcpChildren?: boolean | null;
    readonly catalogIdenticalUnderF5?: boolean | null;
    /** `null` when not checked; hook execution has no generic probe. */
    readonly executedProjectHooks?: ReadonlyArray<string> | null;
    /** Modes whose `session/set_mode` write failed; their steps were skipped. */
    readonly rejectedModes?: ReadonlyArray<string>;
  };
}

export interface AntigravityCaptureFixture {
  readonly fixtureVersion: typeof ANTIGRAVITY_CAPTURE_FIXTURE_VERSION;
  readonly meta: AntigravityCaptureMeta;
  readonly initialize: {
    readonly authMethodIds: ReadonlyArray<string>;
    readonly capabilityFlags: Readonly<Record<string, boolean>>;
  };
  readonly helpFlags: ReadonlyArray<string>;
  readonly session: {
    readonly modeIds: ReadonlyArray<string>;
    readonly currentModeId: string | null;
    readonly configOptions: ReadonlyArray<AntigravityCaptureOption>;
    readonly commandNames: ReadonlyArray<string>;
  };
  readonly models: ReadonlyArray<{
    readonly id: string;
    readonly thoughtLevels: ReadonlyArray<string> | null;
    readonly defaultLevel: string | null;
  }>;
  readonly permissions: ReadonlyArray<{
    readonly step: string;
    readonly sessionMode: string;
    readonly toolKind: string | null;
    readonly optionKinds: ReadonlyArray<string>;
    readonly fieldsPresent: ReadonlyArray<string>;
  }>;
  readonly usage: {
    readonly frames: number;
    readonly frameFields: ReadonlyArray<string>;
    readonly promptResponseFields: ReadonlyArray<string>;
  };
  readonly resume: {
    readonly ok: boolean;
    readonly returnsConfigOptions: boolean;
    readonly returnsModes: boolean;
    readonly modelPreserved: boolean | null;
  } | null;
  readonly steer: {
    readonly secondPromptAccepted: boolean;
    readonly stopReasons: ReadonlyArray<string>;
  } | null;
  readonly backgroundWake: {
    readonly updatesAfterPromptResponse: number;
    readonly kinds: ReadonlyArray<string>;
  } | null;
  readonly stopResend: {
    readonly firstStopReason: string | null;
    readonly secondStopReason: string | null;
  } | null;
  readonly checks: {
    readonly defaultModelPersistsAfterCycling: boolean | null;
    readonly defaultRestoredInFreshProcess: boolean | null;
    readonly apiKeyVisibleToShell: boolean | null;
    readonly apiKeyVisibleToMcpChildren: boolean | null;
    readonly catalogIdenticalUnderF5: boolean | null;
    readonly executedProjectHooks: ReadonlyArray<string> | null;
    readonly rejectedModes: ReadonlyArray<string>;
  };
}

export interface AntigravityCaptureOption {
  readonly id: string;
  readonly category: string | null;
  readonly type: string;
  readonly values: ReadonlyArray<string>;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const identifier = (value: unknown): string | undefined =>
  typeof value === "string" && /^[A-Za-z0-9_.:/#-]{1,128}$/.test(value) ? value : undefined;
const sortedUnique = (values: ReadonlyArray<string>) => [...new Set(values)].toSorted();

/** Boolean presence of every capability path, never the values. `_meta` is skipped. */
export function capabilityFlags(value: unknown, prefix = "", depth = 0): Record<string, boolean> {
  const fields = record(value);
  if (!fields || depth > 4) return {};
  const flags: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(fields)) {
    if (key === "_meta" || !identifier(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const nested = record(entry);
    if (nested && Object.keys(nested).length > 0)
      Object.assign(flags, capabilityFlags(nested, path, depth + 1));
    else flags[path] = entry === true || nested !== undefined;
  }
  return flags;
}

export function projectConfigOptions(value: unknown): AntigravityCaptureOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const option = record(entry);
    const id = identifier(option?.id);
    const type = identifier(option?.type);
    if (!option || !id || !type) return [];
    const values = Array.isArray(option.options)
      ? option.options.flatMap((choice) => {
          const fields = record(choice);
          if (!fields) return [];
          if (Array.isArray(fields.options))
            return fields.options.flatMap((nested) => identifier(record(nested)?.value) ?? []);
          return identifier(fields.value) ?? [];
        })
      : [];
    return [{ id, category: identifier(option.category) ?? null, type, values }];
  });
}

const thoughtOption = (configOptions: unknown) =>
  (Array.isArray(configOptions) ? configOptions : [])
    .map(record)
    .find((option) => option?.category === "thought_level" && option.type === "select");

const presentFields = (value: unknown) =>
  sortedUnique(
    Object.keys(record(value) ?? {}).filter((key) => key !== "_meta" && identifier(key)),
  );

export function projectAntigravityCapture(
  raw: AntigravityCaptureRaw,
  meta: AntigravityCaptureMeta,
): AntigravityCaptureFixture {
  const initialize = record(raw.initialize);
  const modes = record(raw.session?.modes);
  const permissions = (raw.permissions ?? []).map((sample) => {
    const request = record(sample.request);
    const toolCall = record(request?.toolCall);
    const options = Array.isArray(request?.options) ? request.options : [];
    return {
      step: identifier(sample.step) ?? "unknown",
      sessionMode: identifier(sample.sessionMode) ?? "unknown",
      toolKind: identifier(toolCall?.kind) ?? null,
      optionKinds: sortedUnique(
        options.flatMap((option) => identifier(record(option)?.kind) ?? []),
      ),
      fieldsPresent: sortedUnique([
        ...presentFields(toolCall).map((key) => `toolCall.${key}`),
        ...presentFields(record(toolCall?.rawInput)).map((key) => `toolCall.rawInput.${key}`),
      ]),
    };
  });
  const resumeResponse = record(raw.resume?.response);
  const resumedModel = record(
    (Array.isArray(resumeResponse?.configOptions) ? resumeResponse.configOptions : [])
      .map(record)
      .find((option) => option?.category === "model" || option?.id === "model"),
  )?.currentValue;
  const updateKind = (update: unknown) =>
    identifier(record(record(update)?.update)?.sessionUpdate) ??
    identifier(record(update)?.sessionUpdate);
  const stopReason = (value: unknown) =>
    identifier(record(value)?.stopReason) ?? identifier(value) ?? null;
  return {
    fixtureVersion: ANTIGRAVITY_CAPTURE_FIXTURE_VERSION,
    meta: {
      agyVersion: identifier(meta.agyVersion) ?? "unknown",
      platform: identifier(meta.platform) ?? "unknown",
      authMethod: identifier(meta.authMethod) ?? "unknown",
      accountTier: identifier(meta.accountTier) ?? "unknown",
      capturedOn: /^\d{4}-\d{2}-\d{2}$/.test(meta.capturedOn) ? meta.capturedOn : "unknown",
      ...(meta.upstream ? { upstream: meta.upstream } : {}),
    },
    initialize: {
      authMethodIds: (Array.isArray(initialize?.authMethods) ? initialize.authMethods : []).flatMap(
        (method) => identifier(record(method)?.id) ?? [],
      ),
      capabilityFlags: capabilityFlags(initialize?.agentCapabilities),
    },
    helpFlags: sortedUnique(raw.helpText?.match(/(?<![\w-])--[a-z][a-z0-9-]{0,40}/g) ?? []),
    session: {
      modeIds: (Array.isArray(modes?.availableModes) ? modes.availableModes : []).flatMap(
        (mode) => identifier(record(mode)?.id) ?? [],
      ),
      currentModeId: identifier(modes?.currentModeId) ?? null,
      configOptions: projectConfigOptions(raw.session?.configOptions),
      commandNames: sortedUnique(
        (raw.session?.commands ?? []).flatMap((command) => identifier(record(command)?.name) ?? []),
      ),
    },
    models: (raw.models ?? []).flatMap((model) => {
      const id = identifier(model.id);
      if (!id) return [];
      const option = thoughtOption(model.configOptions);
      const levels = option ? (projectConfigOptions([option])[0]?.values ?? []) : null;
      return [
        { id, thoughtLevels: levels, defaultLevel: identifier(option?.currentValue) ?? null },
      ];
    }),
    permissions,
    usage: {
      frames: raw.usageFrames?.length ?? 0,
      frameFields: sortedUnique((raw.usageFrames ?? []).flatMap((frame) => presentFields(frame))),
      promptResponseFields: sortedUnique(
        (raw.promptResponses ?? []).flatMap((response) => [
          ...presentFields(response),
          ...presentFields(record(response)?.usage).map((key) => `usage.${key}`),
        ]),
      ),
    },
    resume: raw.resume
      ? {
          ok: raw.resume.ok,
          returnsConfigOptions: Array.isArray(resumeResponse?.configOptions),
          returnsModes: record(resumeResponse?.modes) !== undefined,
          modelPreserved:
            raw.resume.modelBefore !== undefined && typeof resumedModel === "string"
              ? resumedModel === raw.resume.modelBefore
              : null,
        }
      : null,
    steer: raw.steer
      ? {
          secondPromptAccepted: raw.steer.secondPromptAccepted,
          stopReasons: raw.steer.stopReasons.flatMap((reason) => stopReason(reason) ?? []),
        }
      : null,
    backgroundWake: raw.backgroundWake
      ? {
          updatesAfterPromptResponse: raw.backgroundWake.updatesAfterPromptResponse.length,
          kinds: sortedUnique(
            raw.backgroundWake.updatesAfterPromptResponse.flatMap(
              (update) => updateKind(update) ?? [],
            ),
          ),
        }
      : null,
    stopResend: raw.stopResend
      ? {
          firstStopReason: stopReason(raw.stopResend.firstStopReason),
          secondStopReason: stopReason(raw.stopResend.secondStopReason),
        }
      : null,
    checks: {
      defaultModelPersistsAfterCycling: raw.checks?.defaultModelPersistsAfterCycling ?? null,
      defaultRestoredInFreshProcess: raw.checks?.defaultRestoredInFreshProcess ?? null,
      apiKeyVisibleToShell: raw.checks?.apiKeyVisibleToShell ?? null,
      apiKeyVisibleToMcpChildren: raw.checks?.apiKeyVisibleToMcpChildren ?? null,
      catalogIdenticalUnderF5: raw.checks?.catalogIdenticalUnderF5 ?? null,
      executedProjectHooks:
        raw.checks?.executedProjectHooks === null || raw.checks?.executedProjectHooks === undefined
          ? null
          : sortedUnique(raw.checks.executedProjectHooks.flatMap((hook) => identifier(hook) ?? [])),
      rejectedModes: sortedUnique(
        (raw.checks?.rejectedModes ?? []).flatMap((mode) => identifier(mode) ?? []),
      ),
    },
  };
}
