import { Effect, Schedule } from "effect";
import {
  normalizeOpenCodeSkills,
  OpenCodeRuntimeError,
  parseOpenCodeModelSlug,
  type OpenCodeInventory,
  type OpenCodeRuntimeShape,
} from "./opencodeRuntime.ts";

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// OpenCode 1.x prints a provider/model header followed by a JSON model.
export function parseOpenCodeCliModels(stdout: string): OpenCodeInventory["providerList"] {
  type Provider = OpenCodeInventory["providerList"]["all"][number];
  const providers = new Map<
    string,
    Provider & { models: Record<string, Provider["models"][string]> }
  >();
  const blocks = stdout.split(/^(\S+\/\S+)[ \t\r]*$/m);
  for (let index = 1; index < blocks.length; index += 2) {
    const slug = parseOpenCodeModelSlug(blocks[index]);
    const model = parseJson(blocks[index + 1] ?? "");
    if (
      !slug ||
      !model ||
      typeof model !== "object" ||
      !("name" in model) ||
      typeof model.name !== "string" ||
      !model.name.trim()
    )
      continue;

    let provider = providers.get(slug.providerID);
    if (!provider) {
      provider = { id: slug.providerID, name: slug.providerID, models: Object.create(null) };
      providers.set(slug.providerID, provider);
    }
    const variants = "variants" in model ? model.variants : undefined;
    provider.models[slug.modelID] = {
      id: slug.modelID,
      name: model.name,
      ...(variants && typeof variants === "object" && !Array.isArray(variants)
        ? { variants: variants as NonNullable<Provider["models"][string]["variants"]> }
        : {}),
    };
  }
  return { all: [...providers.values()], connected: [...providers.keys()] };
}

// The CLI omits the hidden flag. OpenCode hides these built-in agents.
const HIDDEN_AGENTS = new Set(["compaction", "summary", "title"]);

export function parseOpenCodeCliAgents(stdout: string): OpenCodeInventory["agents"] {
  const agents: Array<OpenCodeInventory["agents"][number]> = [];
  for (const [, name, mode] of stdout.matchAll(/^(.+?) \((primary|subagent|all)\)[ \t\r]*$/gm)) {
    if (name && (mode === "primary" || mode === "subagent" || mode === "all")) {
      agents.push({ name, mode, hidden: HIDDEN_AGENTS.has(name) });
    }
  }
  return agents;
}

export function loadOpenCodeCliInventory(
  run: OpenCodeRuntimeShape["runOpenCodeCommand"],
  input: Omit<Parameters<typeof run>[0], "args">,
): Effect.Effect<OpenCodeInventory> {
  const read = (args: ReadonlyArray<string>) =>
    Effect.suspend(() => run({ ...input, args })).pipe(
      Effect.flatMap(({ code, stdout, stderr }) =>
        code === 0
          ? Effect.succeed(stdout)
          : Effect.fail(new OpenCodeRuntimeError({ operation: args.join(" "), detail: stderr })),
      ),
      Effect.retry({ times: 1, schedule: Schedule.spaced("1 second") }),
      Effect.orElseSucceed(() => ""),
    );

  return Effect.all(
    {
      providerList: read(["models", "--verbose"]).pipe(Effect.map(parseOpenCodeCliModels)),
      agents: read(["agent", "list"]).pipe(Effect.map(parseOpenCodeCliAgents)),
      skills: read(["debug", "skill"]).pipe(
        Effect.map((stdout) => normalizeOpenCodeSkills(parseJson(stdout))),
      ),
    },
    { concurrency: "unbounded" },
  );
}
