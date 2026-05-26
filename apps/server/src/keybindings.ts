/**
 * Keybindings - Keybinding configuration service definitions.
 *
 * Owns parsing, validation, merge, and persistence of user keybinding
 * configuration consumed by the server runtime.
 *
 * @module Keybindings
 */
import {
  KeybindingRule,
  KeybindingsConfig,
  MAX_KEYBINDINGS_COUNT,
  ResolvedKeybindingRule,
  ResolvedKeybindingsConfig,
  type ServerConfigIssue,
} from "@t3tools/contracts";
import {
  DEFAULT_KEYBINDINGS,
  OBSOLETE_DEFAULT_KEYBINDINGS,
  compileResolvedKeybindingRule,
  compileResolvedKeybindingsConfig,
  encodeKeybindingShortcut,
  encodeWhenAst,
  hasEquivalentKeybindingRule,
  matchesKeybindingTarget,
  mergeWithDefaultKeybindings,
  parseKeybindingShortcut,
} from "@t3tools/shared/keybindings";
import {
  Array,
  Cache,
  Cause,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Path,
  Layer,
  Option,
  Predicate,
  PubSub,
  Schema,
  SchemaGetter,
  SchemaIssue,
  SchemaTransformation,
  Ref,
  ServiceMap,
  Scope,
  Stream,
} from "effect";
import * as Semaphore from "effect/Semaphore";
import { writeFileStringAtomically } from "./atomicWrite";
import { ServerConfig } from "./config";

export {
  DEFAULT_KEYBINDINGS,
  OBSOLETE_DEFAULT_KEYBINDINGS,
  compileResolvedKeybindingRule,
  compileResolvedKeybindingsConfig,
  parseKeybindingShortcut,
} from "@t3tools/shared/keybindings";

export class KeybindingsConfigError extends Schema.TaggedErrorClass<KeybindingsConfigError>()(
  "KeybindingsConfigParseError",
  {
    configPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Unable to parse keybindings config at ${this.configPath}: ${this.detail}`;
  }
}

export class KeybindingTargetNotFoundError extends Schema.TaggedErrorClass<KeybindingTargetNotFoundError>()(
  "KeybindingTargetNotFoundError",
  {
    command: KeybindingRule.fields.command,
    key: Schema.String,
    when: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const when = this.when ? ` when '${this.when}'` : "";
    return `Keybinding target not found for ${this.command} at ${this.key}${when}.`;
  }
}

export const ResolvedKeybindingFromConfig = KeybindingRule.pipe(
  Schema.decodeTo(
    Schema.toType(ResolvedKeybindingRule),
    SchemaTransformation.transformOrFail({
      decode: (rule) =>
        Effect.succeed(compileResolvedKeybindingRule(rule)).pipe(
          Effect.filterOrFail(
            Predicate.isNotNull,
            () =>
              new SchemaIssue.InvalidValue(Option.some(rule), {
                title: "Invalid keybinding rule",
              }),
          ),
          Effect.map((resolved) => resolved),
        ),

      encode: (resolved) =>
        Effect.gen(function* () {
          const key = encodeKeybindingShortcut(resolved.shortcut);
          if (!key) {
            return yield* Effect.fail(
              new SchemaIssue.InvalidValue(Option.some(resolved), {
                title: "Resolved shortcut cannot be encoded to key string",
              }),
            );
          }

          const when = resolved.whenAst ? encodeWhenAst(resolved.whenAst) : undefined;
          return {
            key,
            command: resolved.command,
            when,
          };
        }),
    }),
  ),
);

export const ResolvedKeybindingsFromConfig = Schema.Array(ResolvedKeybindingFromConfig).check(
  Schema.isMaxLength(MAX_KEYBINDINGS_COUNT),
);

const RawKeybindingsEntries = Schema.fromJsonString(Schema.Array(Schema.Unknown));
const KeybindingsConfigJson = Schema.fromJsonString(KeybindingsConfig);
const PrettyJsonString = SchemaGetter.parseJson<string>().compose(
  SchemaGetter.stringifyJson({ space: 2 }),
);
const KeybindingsConfigPrettyJson = KeybindingsConfigJson.pipe(
  Schema.encode({
    decode: PrettyJsonString,
    encode: PrettyJsonString,
  }),
);

export interface KeybindingsConfigState {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly customKeybindings: KeybindingsConfig;
  readonly issues: readonly ServerConfigIssue[];
}

export interface KeybindingsChangeEvent {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly customKeybindings: KeybindingsConfig;
  readonly issues: readonly ServerConfigIssue[];
}

function trimIssueMessage(message: string): string {
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed : "Invalid keybindings configuration.";
}

function malformedConfigIssue(detail: string): ServerConfigIssue {
  return {
    kind: "keybindings.malformed-config",
    message: trimIssueMessage(detail),
  };
}

function invalidEntryIssue(index: number, detail: string): ServerConfigIssue {
  return {
    kind: "keybindings.invalid-entry",
    index,
    message: trimIssueMessage(detail),
  };
}

/**
 * KeybindingsShape - Service API for keybinding configuration operations.
 */
export interface KeybindingsShape {
  /**
   * Start the keybindings runtime and attach file watching.
   *
   * Safe to call multiple times. The first successful call establishes the
   * runtime; later calls await the same startup.
   */
  readonly start: Effect.Effect<void, KeybindingsConfigError>;

  /**
   * Await keybindings runtime readiness.
   *
   * Readiness means the config directory exists, the watcher is attached, the
   * startup sync has completed, and the current snapshot has been loaded.
   */
  readonly ready: Effect.Effect<void, KeybindingsConfigError>;

  /**
   * Ensure the on-disk keybindings file exists and remove legacy persisted
   * defaults. Runtime defaults are merged in memory; the writable file stores
   * custom rules only.
   */
  readonly syncDefaultKeybindingsOnStartup: Effect.Effect<void, KeybindingsConfigError>;

  /**
   * Load runtime keybindings state along with non-fatal configuration issues.
   */
  readonly loadConfigState: Effect.Effect<KeybindingsConfigState, KeybindingsConfigError>;

  /**
   * Read the latest keybindings snapshot from cache/disk.
   */
  readonly getSnapshot: Effect.Effect<KeybindingsConfigState, KeybindingsConfigError>;

  /**
   * Stream of keybindings config change events.
   */
  readonly streamChanges: Stream.Stream<KeybindingsChangeEvent>;

  /**
   * Upsert a keybinding rule and persist the resulting configuration.
   *
   * Writes config atomically and enforces the max rule count by truncating
   * oldest entries when needed.
   */
  readonly upsertKeybindingRule: (
    rule: KeybindingRule,
  ) => Effect.Effect<KeybindingsConfigState, KeybindingsConfigError>;

  readonly addKeybindingRule: (
    rule: KeybindingRule,
  ) => Effect.Effect<KeybindingsConfigState, KeybindingsConfigError>;

  readonly updateKeybindingRule: (input: {
    readonly target: KeybindingRule;
    readonly rule: KeybindingRule;
  }) => Effect.Effect<
    KeybindingsConfigState,
    KeybindingsConfigError | KeybindingTargetNotFoundError
  >;

  readonly removeKeybindingRule: (input: {
    readonly target: KeybindingRule;
  }) => Effect.Effect<KeybindingsConfigState, KeybindingsConfigError>;

  readonly resetKeybindingRules: Effect.Effect<KeybindingsConfigState, KeybindingsConfigError>;
}

/**
 * Keybindings - Service tag for keybinding configuration operations.
 */
export class Keybindings extends ServiceMap.Service<Keybindings, KeybindingsShape>()(
  "t3/keybindings",
) {}

const makeKeybindings = Effect.gen(function* () {
  const { keybindingsConfigPath } = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const upsertSemaphore = yield* Semaphore.make(1);
  const resolvedConfigCacheKey = "resolved" as const;
  const changesPubSub = yield* PubSub.unbounded<KeybindingsChangeEvent>();
  const startedRef = yield* Ref.make(false);
  const pendingSelfWriteIds = yield* Ref.make<ReadonlySet<number>>(new Set());
  const nextSelfWriteId = yield* Ref.make(0);
  const startedDeferred = yield* Deferred.make<void, KeybindingsConfigError>();
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));
  const emitChange = (configState: KeybindingsConfigState) =>
    PubSub.publish(changesPubSub, configState).pipe(Effect.asVoid);

  const readConfigExists = fs.exists(keybindingsConfigPath).pipe(
    Effect.mapError(
      (cause) =>
        new KeybindingsConfigError({
          configPath: keybindingsConfigPath,
          detail: "failed to access keybindings config",
          cause,
        }),
    ),
  );

  const readRawConfig = fs.readFileString(keybindingsConfigPath).pipe(
    Effect.mapError(
      (cause) =>
        new KeybindingsConfigError({
          configPath: keybindingsConfigPath,
          detail: "failed to read keybindings config",
          cause,
        }),
    ),
  );

  const loadWritableCustomKeybindingsConfig = Effect.fn(function* (): Effect.fn.Return<
    readonly KeybindingRule[],
    KeybindingsConfigError
  > {
    if (!(yield* readConfigExists)) {
      return [];
    }

    const rawConfig = yield* readRawConfig.pipe(
      Effect.flatMap(Schema.decodeEffect(RawKeybindingsEntries)),
      Effect.mapError(
        (cause) =>
          new KeybindingsConfigError({
            configPath: keybindingsConfigPath,
            detail: "expected JSON array",
            cause,
          }),
      ),
    );

    return yield* Effect.forEach(rawConfig, (entry) =>
      Effect.gen(function* () {
        const decodedRule = Schema.decodeUnknownExit(KeybindingRule)(entry);
        if (decodedRule._tag === "Failure") {
          yield* Effect.logWarning("ignoring invalid keybinding entry", {
            path: keybindingsConfigPath,
            entry,
            error: Cause.pretty(decodedRule.cause),
          });
          return null;
        }
        const resolved = Schema.decodeExit(ResolvedKeybindingFromConfig)(decodedRule.value);
        if (resolved._tag === "Failure") {
          yield* Effect.logWarning("ignoring invalid keybinding entry", {
            path: keybindingsConfigPath,
            entry,
            error: Cause.pretty(resolved.cause),
          });
          return null;
        }
        return decodedRule.value;
      }),
    ).pipe(Effect.map(Array.filter(Predicate.isNotNull)));
  });

  const loadRuntimeCustomKeybindingsConfig = Effect.fn(function* (): Effect.fn.Return<
    {
      readonly keybindings: readonly KeybindingRule[];
      readonly issues: readonly ServerConfigIssue[];
    },
    KeybindingsConfigError
  > {
    if (!(yield* readConfigExists)) {
      return { keybindings: [], issues: [] };
    }

    const rawConfig = yield* readRawConfig;
    const decodedEntries = Schema.decodeUnknownExit(RawKeybindingsEntries)(rawConfig);
    if (decodedEntries._tag === "Failure") {
      const detail = `expected JSON array (${Cause.pretty(decodedEntries.cause)})`;
      return {
        keybindings: [],
        issues: [malformedConfigIssue(detail)],
      };
    }

    const keybindings: KeybindingRule[] = [];
    const issues: ServerConfigIssue[] = [];
    for (const [index, entry] of decodedEntries.value.entries()) {
      const decodedRule = Schema.decodeUnknownExit(KeybindingRule)(entry);
      if (decodedRule._tag === "Failure") {
        const detail = Cause.pretty(decodedRule.cause);
        issues.push(invalidEntryIssue(index, detail));
        yield* Effect.logWarning("ignoring invalid keybinding entry", {
          path: keybindingsConfigPath,
          index,
          entry,
          error: detail,
        });
        continue;
      }

      const resolvedRule = Schema.decodeExit(ResolvedKeybindingFromConfig)(decodedRule.value);
      if (resolvedRule._tag === "Failure") {
        const detail = Cause.pretty(resolvedRule.cause);
        issues.push(invalidEntryIssue(index, detail));
        yield* Effect.logWarning("ignoring invalid keybinding entry", {
          path: keybindingsConfigPath,
          index,
          entry,
          error: detail,
        });
        continue;
      }
      keybindings.push(decodedRule.value);
    }

    return { keybindings, issues };
  });

  const writeConfigAtomically = (rules: readonly KeybindingRule[]) =>
    Schema.encodeEffect(KeybindingsConfigPrettyJson)(rules).pipe(
      Effect.map((encoded) => `${encoded}\n`),
      Effect.flatMap((encoded) =>
        writeFileStringAtomically({
          filePath: keybindingsConfigPath,
          contents: encoded,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
      ),
      Effect.mapError(
        (cause) =>
          new KeybindingsConfigError({
            configPath: keybindingsConfigPath,
            detail: "failed to write keybindings config",
            cause,
          }),
      ),
    );

  const SELF_WRITE_SUPPRESSION_WINDOW_MS = 500;
  const registerSelfWrite = Effect.gen(function* () {
    const writeId = yield* Ref.modify(nextSelfWriteId, (current) => [current, current + 1]);
    yield* Ref.update(pendingSelfWriteIds, (ids) => {
      const next = new Set(ids);
      next.add(writeId);
      return next;
    });
    yield* Effect.sync(() => {
      const timeout = setTimeout(() => {
        Effect.runFork(
          Ref.update(pendingSelfWriteIds, (ids) => {
            if (!ids.has(writeId)) {
              return ids;
            }
            const next = new Set(ids);
            next.delete(writeId);
            return next;
          }),
        );
      }, SELF_WRITE_SUPPRESSION_WINDOW_MS);
      timeout.unref?.();
    });
    return writeId;
  });

  const clearSelfWrite = (writeId: number) =>
    Ref.update(pendingSelfWriteIds, (ids) => {
      if (!ids.has(writeId)) {
        return ids;
      }
      const next = new Set(ids);
      next.delete(writeId);
      return next;
    });

  const writeConfigForServiceMutation = (rules: readonly KeybindingRule[]) =>
    Effect.gen(function* () {
      const writeId = yield* registerSelfWrite;
      return yield* writeConfigAtomically(rules).pipe(
        Effect.tapError(() => clearSelfWrite(writeId)),
      );
    });

  const isLegacyPersistedDefault = (rule: KeybindingRule) =>
    hasEquivalentKeybindingRule(DEFAULT_KEYBINDINGS, rule) ||
    hasEquivalentKeybindingRule(OBSOLETE_DEFAULT_KEYBINDINGS, rule);

  const sanitizeCustomKeybindings = (rules: readonly KeybindingRule[]) =>
    rules.filter((rule) => !isLegacyPersistedDefault(rule));

  const buildConfigState = (
    customKeybindings: readonly KeybindingRule[],
    issues: readonly ServerConfigIssue[],
  ): KeybindingsConfigState => ({
    keybindings: mergeWithDefaultKeybindings(
      compileResolvedKeybindingsConfig(sanitizeCustomKeybindings(customKeybindings)),
    ),
    customKeybindings: sanitizeCustomKeybindings(customKeybindings),
    issues,
  });

  const capKeybindingsConfig = (rules: readonly KeybindingRule[]) =>
    rules.length > MAX_KEYBINDINGS_COUNT ? rules.slice(-MAX_KEYBINDINGS_COUNT) : [...rules];

  const persistConfigState = (
    customKeybindings: readonly KeybindingRule[],
    issues: readonly ServerConfigIssue[] = [],
  ) =>
    Effect.gen(function* () {
      const sanitizedConfig = sanitizeCustomKeybindings(customKeybindings);
      const cappedConfig = capKeybindingsConfig(sanitizedConfig);
      if (sanitizedConfig.length > MAX_KEYBINDINGS_COUNT) {
        yield* Effect.logWarning("truncating keybindings config to max entries", {
          path: keybindingsConfigPath,
          maxEntries: MAX_KEYBINDINGS_COUNT,
        });
      }
      yield* writeConfigForServiceMutation(cappedConfig);
      const nextState = buildConfigState(cappedConfig, issues);
      yield* Cache.set(resolvedConfigCache, resolvedConfigCacheKey, nextState);
      yield* emitChange(nextState);
      return nextState;
    });

  const loadConfigStateFromDisk = loadRuntimeCustomKeybindingsConfig().pipe(
    Effect.map(({ keybindings, issues }) => buildConfigState(keybindings, issues)),
  );

  const resolvedConfigCache = yield* Cache.make<
    typeof resolvedConfigCacheKey,
    KeybindingsConfigState,
    KeybindingsConfigError
  >({
    capacity: 1,
    lookup: () => loadConfigStateFromDisk,
  });

  const loadConfigStateFromCacheOrDisk = Cache.get(resolvedConfigCache, resolvedConfigCacheKey);

  const revalidateAndEmit = upsertSemaphore.withPermits(1)(
    Effect.gen(function* () {
      yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
      const configState = yield* loadConfigStateFromCacheOrDisk;
      yield* emitChange(configState);
    }),
  );

  const syncDefaultKeybindingsOnStartup = upsertSemaphore.withPermits(1)(
    Effect.gen(function* () {
      if (!(yield* readConfigExists)) {
        yield* writeConfigForServiceMutation([]);
        yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
        return;
      }

      const runtimeConfig = yield* loadRuntimeCustomKeybindingsConfig();
      if (runtimeConfig.issues.length > 0) {
        yield* Effect.logWarning(
          "skipping startup keybindings default sync because config has issues",
          {
            path: keybindingsConfigPath,
            issues: runtimeConfig.issues,
          },
        );
        yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
        return;
      }
      const customConfig = runtimeConfig.keybindings;
      const sanitizedConfig = sanitizeCustomKeybindings(customConfig);
      const removedObsoleteDefaults = customConfig.length - sanitizedConfig.length;
      if (removedObsoleteDefaults > 0) {
        yield* Effect.logInfo("removed legacy persisted default keybindings from config", {
          path: keybindingsConfigPath,
          removedEntries: removedObsoleteDefaults,
          commands: customConfig
            .filter((rule) => isLegacyPersistedDefault(rule))
            .map((rule) => rule.command),
        });
      }

      if (removedObsoleteDefaults > 0) {
        yield* writeConfigForServiceMutation(sanitizedConfig);
      }
      yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
    }),
  );

  const startWatcher = Effect.gen(function* () {
    const keybindingsConfigDir = path.dirname(keybindingsConfigPath);
    const keybindingsConfigFile = path.basename(keybindingsConfigPath);
    const keybindingsConfigPathResolved = path.resolve(keybindingsConfigPath);

    yield* fs.makeDirectory(keybindingsConfigDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new KeybindingsConfigError({
            configPath: keybindingsConfigPath,
            detail: "failed to prepare keybindings config directory",
            cause,
          }),
      ),
    );

    const revalidateAndEmitSafely = revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));

    yield* Stream.runForEach(fs.watch(keybindingsConfigDir), (event) => {
      const isTargetConfigEvent =
        event.path === keybindingsConfigFile ||
        event.path === keybindingsConfigPath ||
        path.resolve(keybindingsConfigDir, event.path) === keybindingsConfigPathResolved;
      if (!isTargetConfigEvent) {
        return Effect.void;
      }
      const skipSelfWrite = Ref.modify(pendingSelfWriteIds, (ids) => {
        const [writeId] = ids;
        if (writeId === undefined) {
          return [false, ids];
        }
        const next = new Set(ids);
        next.delete(writeId);
        return [true, next];
      });
      return skipSelfWrite.pipe(
        Effect.flatMap((shouldSkip) => (shouldSkip ? Effect.void : revalidateAndEmitSafely)),
      );
    }).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(watcherScope), Effect.asVoid);
  });

  const start = Effect.gen(function* () {
    const alreadyStarted = yield* Ref.get(startedRef);
    if (alreadyStarted) {
      return yield* Deferred.await(startedDeferred);
    }

    yield* Ref.set(startedRef, true);
    const startup = Effect.gen(function* () {
      yield* startWatcher;
      yield* syncDefaultKeybindingsOnStartup;
      yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
      yield* loadConfigStateFromCacheOrDisk;
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  return {
    start,
    ready: Deferred.await(startedDeferred),
    syncDefaultKeybindingsOnStartup,
    loadConfigState: loadConfigStateFromCacheOrDisk,
    getSnapshot: loadConfigStateFromCacheOrDisk,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
    upsertKeybindingRule: (rule) =>
      upsertSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const preWriteState = yield* loadConfigStateFromCacheOrDisk;
          const customConfig = yield* loadWritableCustomKeybindingsConfig();
          const nextConfig = [
            ...customConfig.filter((entry) => entry.command !== rule.command),
            rule,
          ];
          return yield* persistConfigState(nextConfig, preWriteState.issues);
        }),
      ),
    addKeybindingRule: (rule) =>
      upsertSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const preWriteState = yield* loadConfigStateFromCacheOrDisk;
          const customConfig = yield* loadWritableCustomKeybindingsConfig();
          if (hasEquivalentKeybindingRule(customConfig, rule)) {
            return buildConfigState(customConfig, preWriteState.issues);
          }
          return yield* persistConfigState([...customConfig, rule], preWriteState.issues);
        }),
      ),
    updateKeybindingRule: ({ target, rule }) =>
      upsertSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const preWriteState = yield* loadConfigStateFromCacheOrDisk;
          const customConfig = yield* loadWritableCustomKeybindingsConfig();
          const targetIndex = customConfig.findIndex((entry) =>
            matchesKeybindingTarget(entry, target),
          );
          if (targetIndex === -1) {
            return yield* new KeybindingTargetNotFoundError({
              command: target.command,
              key: target.key,
              ...(target.when !== undefined ? { when: target.when } : {}),
            });
          }
          const nextConfig: KeybindingRule[] = [];
          for (const [index, entry] of customConfig.entries()) {
            if (index === targetIndex) {
              nextConfig.push(rule);
              continue;
            }
            if (hasEquivalentKeybindingRule([entry], rule)) {
              continue;
            }
            nextConfig.push(entry);
          }
          return yield* persistConfigState(nextConfig, preWriteState.issues);
        }),
      ),
    removeKeybindingRule: ({ target }) =>
      upsertSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const preWriteState = yield* loadConfigStateFromCacheOrDisk;
          const customConfig = yield* loadWritableCustomKeybindingsConfig();
          const nextConfig = customConfig.filter(
            (entry) => !matchesKeybindingTarget(entry, target),
          );
          if (nextConfig.length === customConfig.length) {
            return buildConfigState(customConfig, preWriteState.issues);
          }
          return yield* persistConfigState(nextConfig, preWriteState.issues);
        }),
      ),
    resetKeybindingRules: upsertSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const preWriteState = yield* loadConfigStateFromCacheOrDisk;
        return yield* persistConfigState([], preWriteState.issues);
      }),
    ),
  } satisfies KeybindingsShape;
});

export const KeybindingsLive = Layer.effect(Keybindings, makeKeybindings);
