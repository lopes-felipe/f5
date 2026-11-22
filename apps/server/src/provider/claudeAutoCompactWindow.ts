import { Effect, FileSystem, Schema } from "effect";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { claudeSettingsFilesByPrecedence } from "./claudeSettingsFiles.ts";

const CompactSettings = Schema.Struct({
  autoCompactEnabled: Schema.optionalKey(Schema.Unknown),
  autoCompactWindow: Schema.optionalKey(Schema.Unknown),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  modelSettings: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
const decodeCompactSettingsFile = Schema.decodeUnknownEffect(fromLenientJson(CompactSettings));

function validWindow(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100_000 &&
    value <= 1_000_000
    ? value
    : undefined;
}

export const resolveClaudeAutoCompactWindow = Effect.fn("resolveClaudeAutoCompactWindow")(
  function* (input: {
    readonly cwd?: string | undefined;
    readonly configDirectory: string;
    readonly homeDirectory: string;
    readonly platform: NodeJS.Platform;
    readonly environment: NodeJS.ProcessEnv;
    readonly model?: string | undefined;
    readonly launchSettings?: unknown;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* claudeSettingsFilesByPrecedence(input);
    const launch = Schema.decodeUnknownOption(CompactSettings)(input.launchSettings);
    const files = yield* Effect.forEach(paths, (file) =>
      fs.readFileString(file).pipe(
        Effect.flatMap(decodeCompactSettingsFile),
        Effect.orElseSucceed(() => undefined),
      ),
    );
    const layers = [launch._tag === "Some" ? launch.value : undefined, ...files];
    const env = (name: string) =>
      layers.map((settings) => settings?.env?.[name]).find((value) => typeof value === "string") ??
      input.environment[name];
    const enabled = layers
      .map((settings) => settings?.autoCompactEnabled)
      .find((value) => typeof value === "boolean");
    if (
      enabled === false ||
      ["DISABLE_COMPACT", "DISABLE_AUTO_COMPACT"].some((name) =>
        /^(?:1|true|yes|on)$/i.test(env(name)?.trim() ?? ""),
      )
    ) {
      return undefined;
    }
    const override =
      launch._tag === "Some" ? validWindow(launch.value.autoCompactWindow) : undefined;
    if (override !== undefined) return override;
    const envWindow = validWindow(Number(env("CLAUDE_CODE_AUTO_COMPACT_WINDOW")));
    if (envWindow !== undefined) return envWindow;
    const model = input.model?.replace(/\[1m\]$/i, "");
    for (const settings of layers) {
      const modelSettings = model ? settings?.modelSettings?.[model] : undefined;
      const modelWindow =
        modelSettings && typeof modelSettings === "object"
          ? Reflect.get(modelSettings, "autoCompactWindow")
          : undefined;
      if (modelWindow === "auto") return undefined;
      const window = validWindow(modelWindow) ?? validWindow(settings?.autoCompactWindow);
      if (window !== undefined) return window;
    }
  },
);
