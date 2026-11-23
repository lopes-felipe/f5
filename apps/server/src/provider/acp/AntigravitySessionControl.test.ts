import * as fs from "node:fs/promises";
import os from "node:os";
import * as NodePath from "node:path";
import { Effect } from "effect";
import * as AcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AcpSessionModeState } from "./AcpRuntimeModel.ts";
import {
  antigravityAdvertisedModes,
  antigravityApprovalDecision,
  antigravityTargetMode,
  antigravityTextGenerationModel,
  applyAntigravityModelSelection,
  applyAntigravitySessionMode,
  applyAntigravityTextGenerationSelection,
  lowestAntigravityThinkingLevel,
  makeAntigravitySelectionState,
} from "./AntigravityAcpSupport.ts";
import { antigravityEditTargetsInWorkspace } from "./AntigravityEditLocation.ts";

type Option = EffectAcpSchema.SessionConfigOption;

const LEVELS: Record<string, { readonly levels: string[]; readonly fallback: string } | null> = {
  orchestrator: null,
  neon: { levels: ["low", "medium", "high"], fallback: "medium" },
  carbon: { levels: ["low", "high"], fallback: "high" },
  hydrogen: { levels: ["minimal", "low"], fallback: "low" },
};

/** A session whose thinking control changes with the selected model, like Antigravity's. */
function fakeSession(initialModel = "neon") {
  let model = initialModel;
  const levels = new Map<string, string>();
  const writes: string[] = [];
  const options = (): Option[] => {
    const select: Option[] = [
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: model,
        options: Object.keys(LEVELS).map((value) => ({ value, name: value })),
      } as Option,
    ];
    const thinking = LEVELS[model];
    if (thinking)
      select.push({
        type: "select",
        id: "thought_level",
        name: "Thinking",
        category: "thought_level",
        currentValue: levels.get(model) ?? thinking.fallback,
        options: thinking.levels.map((value) => ({ value, name: value })),
      } as Option);
    return select;
  };
  const runtime = {
    getConfigOptions: Effect.sync(options),
    setModel: (next: string) =>
      Effect.sync(() => {
        writes.push(`model=${next}`);
        model = next;
        // The harness resets the level to the model's default on every switch.
        levels.delete(next);
      }),
    setConfigOption: (id: string, value: string | boolean) =>
      Effect.sync(() => {
        writes.push(`${id}=${String(value)}`);
        levels.set(model, String(value));
        return {} as EffectAcpSchema.SetSessionConfigOptionResponse;
      }),
  };
  return { runtime, writes, current: () => ({ model, level: levels.get(model) }) };
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const select = (
  session: ReturnType<typeof fakeSession>,
  requestedModel: string | undefined,
  requestedThinking: string | undefined,
  state = makeAntigravitySelectionState(),
) =>
  run(
    applyAntigravityModelSelection({
      runtime: session.runtime,
      requestedModel,
      requestedThinking,
      state,
      mapError: (cause) => cause,
    }),
  );

describe("Antigravity model and thinking selection", () => {
  it("sets the model, then writes a level only when that model lists it", async () => {
    const session = fakeSession("neon");
    const result = await select(session, "carbon", "low");
    expect(session.writes).toEqual(["model=carbon", "thought_level=low"]);
    expect(result).toEqual({ model: "carbon", thinking: "low" });
  });

  it("falls back to the model default with one warning per model and level", async () => {
    const session = fakeSession("neon");
    const state = makeAntigravitySelectionState();
    const first = await select(session, "carbon", "medium", state);
    expect(first.warning).toContain("'medium' is not available for carbon");
    expect(first.thinking).toBe("high");
    expect((await select(session, "carbon", "medium", state)).warning).toBeUndefined();
    const orchestrator = await select(session, "orchestrator", "high", state);
    expect(orchestrator.thinking).toBeUndefined();
    expect(orchestrator.warning).toContain("orchestrator");
    expect(session.writes).not.toContain("thought_level=medium");
  });

  it("restores the model's own level when the selection is cleared", async () => {
    const session = fakeSession("neon");
    const state = makeAntigravitySelectionState();
    await select(session, "neon", "high", state);
    expect(session.current().level).toBe("high");
    const cleared = await select(session, "neon", undefined, state);
    expect(cleared.thinking).toBe("medium");
    expect(session.writes.at(-1)).toBe("thought_level=medium");
  });

  it("translates a legacy effort-suffixed ID only when both parts are advertised", async () => {
    const session = fakeSession("neon");
    const translated = await select(session, "carbon-low", undefined);
    expect(translated).toEqual({ model: "carbon", thinking: "low" });
    // An explicit level beats the suffix.
    expect((await select(fakeSession("neon"), "carbon-low", "high")).thinking).toBe("high");
    const unmatched = fakeSession("neon");
    await expect(select(unmatched, "carbon-medium", undefined)).rejects.toThrow(/unavailable/);
    expect(unmatched.current().model).toBe("neon");
  });

  it("fails on an unavailable model before writing anything", async () => {
    const session = fakeSession("neon");
    await expect(select(session, "gemini-retired", "high")).rejects.toThrow(
      "Antigravity model 'gemini-retired' is unavailable for this account.",
    );
    expect(session.writes).toEqual([]);
  });

  it("keeps the account default for the legacy default model ID", async () => {
    const session = fakeSession("carbon");
    expect(await select(session, "antigravity-default", undefined)).toEqual({
      model: "carbon",
      thinking: "high",
    });
    expect(session.writes).toEqual([]);
  });

  it("picks Hydrogen at its lowest level for text generation, then restores the selection", async () => {
    const session = fakeSession("neon");
    await select(session, "neon", "high");
    expect(antigravityTextGenerationModel(await run(session.runtime.getConfigOptions))).toBe(
      "hydrogen",
    );
    const restore = await run(
      applyAntigravityTextGenerationSelection({
        runtime: session.runtime,
        model: "antigravity-default",
        thinking: undefined,
      }),
    );
    expect(session.current()).toEqual({ model: "hydrogen", level: "minimal" });
    await run(restore);
    expect(session.current()).toEqual({ model: "neon", level: "high" });
  });

  it("restores the model when text-generation setup fails after switching it", async () => {
    const session = fakeSession("neon");
    // The model switch succeeds, then the level write fails.
    const failingLevel = {
      ...session.runtime,
      setConfigOption: (id: string, value: string | boolean) =>
        id === "thought_level" && value === "minimal"
          ? Effect.fail(new AcpErrors.AcpRequestError({ code: -32603, errorMessage: "rejected" }))
          : session.runtime.setConfigOption(id, value),
    };
    await expect(
      run(
        applyAntigravityTextGenerationSelection({
          runtime: failingLevel,
          model: "antigravity-default",
          thinking: undefined,
        }),
      ),
    ).rejects.toThrow();
    expect(session.current().model).toBe("neon");
  });

  it("keeps an explicit model's requested, suffixed or default level for text generation", async () => {
    const selectFor = (session: ReturnType<typeof fakeSession>, model: string) =>
      run(
        applyAntigravityTextGenerationSelection({
          runtime: session.runtime,
          model,
          thinking: undefined,
        }).pipe(Effect.asVoid),
      );
    const explicit = fakeSession("neon");
    await selectFor(explicit, "carbon");
    // No level requested: the model's own default, not the lowest.
    expect(explicit.writes).toEqual(["model=carbon"]);
    // Hydrogen defaults to `low`; the `-minimal` suffix is kept, not replaced by the lowest.
    const suffixed = fakeSession("neon");
    await selectFor(suffixed, "hydrogen-minimal");
    expect(suffixed.current()).toEqual({ model: "hydrogen", level: "minimal" });
    const neonSuffix = fakeSession("carbon");
    await selectFor(neonSuffix, "neon-high");
    expect(neonSuffix.current()).toEqual({ model: "neon", level: "high" });
  });

  it("orders levels by name when choosing the lowest", () => {
    expect(
      lowestAntigravityThinkingLevel([{ value: "high" }, { value: "low" }, { value: "medium" }]),
    ).toBe("low");
    expect(lowestAntigravityThinkingLevel([{ value: "turbo" }, { value: "minimal" }])).toBe(
      "minimal",
    );
  });

  it("restores the previous model and level when a legacy suffix is rejected", async () => {
    const session = fakeSession("neon");
    await select(session, "neon", "high");
    await expect(select(session, "carbon-medium", undefined)).rejects.toThrow(/unavailable/);
    expect(session.current()).toEqual({ model: "neon", level: "high" });
  });
});

const modeRuntime = (input: {
  readonly modeState?: AcpSessionModeState;
  readonly configMode?: { readonly current: string; readonly values: string[] };
}) => {
  const writes: string[] = [];
  let modeState = input.modeState;
  let configCurrent = input.configMode?.current;
  return {
    writes,
    runtime: {
      getModeState: Effect.sync(() => modeState),
      getConfigOptions: Effect.sync((): Option[] =>
        input.configMode
          ? [
              {
                type: "select",
                id: "mode",
                name: "Mode",
                category: "mode",
                currentValue: configCurrent ?? "",
                options: input.configMode.values.map((value) => ({ value, name: value })),
              } as Option,
            ]
          : [],
      ),
      setNativeMode: (mode: string) =>
        Effect.sync(() => {
          writes.push(`session/set_mode=${mode}`);
          if (modeState) modeState = { ...modeState, currentModeId: mode };
        }),
      setConfigOption: (id: string, value: string | boolean) =>
        Effect.sync(() => {
          writes.push(`config:${id}=${String(value)}`);
          configCurrent = String(value);
          return {} as EffectAcpSchema.SetSessionConfigOptionResponse;
        }),
    },
  };
};
const modes = (current: string, ...ids: string[]): AcpSessionModeState => ({
  currentModeId: current,
  availableModes: ids.map((id) => ({ id, name: id })),
});
const applyMode = (
  runtime: ReturnType<typeof modeRuntime>["runtime"],
  target: "default" | "plan" | "auto",
) => run(applyAntigravitySessionMode({ runtime, target, mapError: (cause) => cause }));

describe("Antigravity session modes", () => {
  it("maps plan, Auto and every F5-enforced mode to one native target", () => {
    const advertised = ["default", "plan"];
    expect(antigravityTargetMode({ runtimeMode: "full-access", plan: true, advertised })).toBe(
      "plan",
    );
    for (const runtimeMode of ["approval-required", "auto-accept-edits", "full-access"] as const)
      expect(antigravityTargetMode({ runtimeMode, plan: false, advertised })).toBe("default");
    expect(antigravityTargetMode({ runtimeMode: "auto", plan: false, advertised })).toBe("default");
    expect(
      antigravityTargetMode({
        runtimeMode: "auto",
        plan: false,
        advertised: [...advertised, "auto"],
      }),
    ).toBe("auto");
  });

  it("writes through session/set_mode only, and skips a mode that is already current", async () => {
    const session = modeRuntime({
      modeState: modes("default", "default", "plan"),
      configMode: { current: "default", values: ["default", "plan"] },
    });
    await applyMode(session.runtime, "plan");
    await applyMode(session.runtime, "plan");
    await applyMode(session.runtime, "default");
    expect(session.writes).toEqual(["session/set_mode=plan", "session/set_mode=default"]);
  });

  it("falls back to the mode config option when no mode state is advertised", async () => {
    const session = modeRuntime({
      configMode: { current: "default", values: ["default", "plan"] },
    });
    expect(
      antigravityAdvertisedModes(undefined, await run(session.runtime.getConfigOptions)),
    ).toMatchObject({ surface: "config-option", configId: "mode", modes: ["default", "plan"] });
    await applyMode(session.runtime, "plan");
    expect(session.writes).toEqual(["config:mode=plan"]);
  });

  it("fails clearly when Plan is not advertised and never prompts in the wrong mode", async () => {
    const session = modeRuntime({ modeState: modes("default", "default") });
    await expect(applyMode(session.runtime, "plan")).rejects.toThrow(
      "This Antigravity runtime does not offer Plan mode.",
    );
    expect(session.writes).toEqual([]);
  });

  it("fails rather than silently staying in Plan", async () => {
    const session = modeRuntime({ modeState: modes("plan", "plan") });
    await expect(applyMode(session.runtime, "default")).rejects.toThrow("could not leave Plan");
  });

  it("fails rather than silently staying in native Auto", async () => {
    // A resumed session in Auto that does not offer `default`.
    const session = modeRuntime({ modeState: modes("auto", "auto", "plan") });
    await expect(applyMode(session.runtime, "default")).rejects.toThrow(
      "could not leave native Auto",
    );
  });

  it("fails when the agent accepts a switch but keeps the previous mode", async () => {
    const session = modeRuntime({ modeState: modes("default", "default", "plan") });
    const ignoring = { ...session.runtime, setNativeMode: () => Effect.void };
    await expect(applyMode(ignoring, "plan")).rejects.toThrow(
      "accepted the switch to 'plan' but stayed in 'default'",
    );
  });

  it("records no Auto fallback when the switch to default also fails", async () => {
    // Coming from Plan, both the Auto write and the fallback write to default really run.
    const session = modeRuntime({ modeState: modes("plan", "plan", "default", "auto") });
    const warnings: string[] = [];
    await expect(
      run(
        applyAntigravitySessionMode({
          runtime: {
            ...session.runtime,
            setNativeMode: () =>
              Effect.fail(
                new AcpErrors.AcpRequestError({ code: -32603, errorMessage: "rejected" }),
              ),
          },
          target: "auto",
          mapError: (cause) => cause,
          onAutoFallback: (warning) => warnings.push(warning),
        }),
      ),
    ).rejects.toThrow();
    expect(warnings).toEqual([]);
  });

  it("falls back to default with one warning when native Auto is rejected", async () => {
    const session = modeRuntime({ modeState: modes("default", "default", "auto") });
    const rejecting = {
      ...session.runtime,
      setNativeMode: (mode: string) =>
        mode === "auto"
          ? Effect.fail(new AcpErrors.AcpRequestError({ code: -32603, errorMessage: "rejected" }))
          : session.runtime.setNativeMode(mode),
    };
    const warnings: string[] = [];
    const mode = await run(
      applyAntigravitySessionMode({
        runtime: rejecting,
        target: "auto",
        mapError: (cause) => cause,
        onAutoFallback: (warning) => warnings.push(warning),
      }),
    );
    expect(mode).toBe("default");
    expect(warnings).toHaveLength(1);
  });
});

describe("Antigravity approval policy", () => {
  let root: string;
  let outside: string;
  beforeAll(async () => {
    const base = await fs.realpath(await fs.mkdtemp(NodePath.join(os.tmpdir(), "f5-agy-policy-")));
    root = NodePath.join(base, "workspace");
    outside = NodePath.join(base, "outside");
    await fs.mkdir(NodePath.join(root, "src"), { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    // A junction needs no symlink privilege on Windows and behaves the same for directories.
    await fs.symlink(
      outside,
      NodePath.join(root, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
  });
  afterAll(async () => {
    await fs.rm(NodePath.dirname(root), { recursive: true, force: true });
  });

  const edit = (target: string) => ({
    kind: "edit",
    title: "replace_file_content",
    rawInput: { TargetFile: target },
    locations: [{ path: target }],
  });
  const command = {
    kind: "execute",
    title: "run_command",
    rawInput: { CommandLine: "rm -rf /" },
  };
  const decide = (
    runtimeMode: Parameters<typeof antigravityApprovalDecision>[0]["runtimeMode"],
    toolCall: Parameters<typeof antigravityApprovalDecision>[0]["toolCall"],
    extra: { sessionMode?: string; computerRequest?: boolean; planRequested?: boolean } = {},
  ) =>
    antigravityApprovalDecision({
      runtimeMode,
      sessionMode: extra.sessionMode ?? "default",
      planRequested: extra.planRequested ?? false,
      computerRequest: extra.computerRequest ?? false,
      toolCall,
      workspaceRoot: root,
    });

  it("asks with grants in Supervised and Auto", () => {
    expect(decide("approval-required", edit(NodePath.join(root, "a.ts")))).toEqual({
      kind: "ask",
      applyThreadGrants: true,
    });
    expect(decide("auto", command)).toEqual({ kind: "ask", applyThreadGrants: true });
  });

  it("allows only workspace edits under Auto-accept edits", () => {
    expect(decide("auto-accept-edits", edit(NodePath.join(root, "src", "new.ts")))).toEqual({
      kind: "allow",
    });
    for (const toolCall of [
      command,
      edit(NodePath.join(outside, "x.ts")),
      edit(NodePath.join(root, "escape", "x.ts")),
      edit(NodePath.join(root, "..", "outside", "x.ts")),
      edit("relative.ts"),
      {
        kind: "edit",
        title: "write_to_file",
        rawInput: { TargetFile: NodePath.join(root, "a"), Cwd: "/" },
      },
      { kind: "edit", title: "write_to_file" },
      // An edit-like title never qualifies another kind.
      {
        kind: "execute",
        title: "write_to_file",
        rawInput: { TargetFile: NodePath.join(root, "a.ts") },
        locations: [{ path: NodePath.join(root, "a.ts") }],
      },
      // The title must lead with the tool name, not merely contain it.
      {
        kind: "edit",
        title: "run `sh -c x` then write_to_file",
        locations: [{ path: NodePath.join(root, "a.ts") }],
      },
      // Shared ACP command fields make the request ambiguous.
      {
        kind: "edit",
        title: "write_to_file",
        rawInput: { TargetFile: NodePath.join(root, "a.ts"), executable: "sh", args: ["-c", "x"] },
      },
      // An edit kind with neither an edit tool name nor an edit target field.
      { kind: "edit", title: "Do something", locations: [{ path: NodePath.join(root, "a.ts") }] },
    ])
      expect(decide("auto-accept-edits", toolCall), JSON.stringify(toolCall)).toEqual({
        kind: "ask",
        applyThreadGrants: true,
      });
  });

  it("allows everything under Full access except computer use", () => {
    expect(decide("full-access", command)).toEqual({ kind: "allow" });
    expect(decide("full-access", edit(NodePath.join(root, "a.ts")))).toEqual({ kind: "allow" });
    expect(decide("full-access", command, { computerRequest: true })).toEqual({
      kind: "ask",
      applyThreadGrants: false,
    });
  });

  it("lets Plan commands follow the access mode but asks for every other kind", () => {
    // A Plan turn whose native mode still reports `default` gets Plan's rules too.
    for (const plan of [{ sessionMode: "plan" }, { sessionMode: "default", planRequested: true }]) {
      for (const kind of ["execute", "read", "search", "think"]) {
        expect(decide("full-access", { ...command, kind }, plan), kind).toEqual({
          kind: "allow",
        });
        expect(decide("approval-required", { ...command, kind }, plan), kind).toEqual({
          kind: "ask",
          applyThreadGrants: true,
        });
      }
      // `kind` comes from the agent: a write tool reported as `other`, with no kind or with a
      // kind F5 doesn't know still asks.
      const writeTool = {
        title: "write_to_file",
        rawInput: { TargetFile: NodePath.join(root, "a.ts") },
      };
      for (const toolCall of [
        ...["edit", "delete", "move", "other", "fetch", "switch_mode", "future_kind"].map(
          (kind) => ({ ...writeTool, kind }),
        ),
        writeTool,
        { ...writeTool, kind: null },
      ])
        expect(decide("full-access", toolCall, plan), JSON.stringify(toolCall)).toEqual({
          kind: "ask",
          applyThreadGrants: false,
        });
      // Auto-accept edits doesn't approve workspace edits in Plan either.
      expect(decide("auto-accept-edits", edit(NodePath.join(root, "a.ts")), plan)).toEqual({
        kind: "ask",
        applyThreadGrants: false,
      });
      expect(decide("full-access", command, { ...plan, computerRequest: true })).toEqual({
        kind: "ask",
        applyThreadGrants: false,
      });
    }
  });

  it("requires every edit target to be inside the canonical workspace", () => {
    const edit = (...paths: string[]) => ({
      kind: "edit",
      title: "write_to_file",
      locations: paths.map((path) => ({ path })),
    });
    // The same request without the outside diff is approved, so the diff is what refuses it.
    expect(antigravityEditTargetsInWorkspace(edit(NodePath.join(root, "a.ts")), root)).toBe(true);
    expect(
      antigravityEditTargetsInWorkspace(
        {
          ...edit(NodePath.join(root, "a.ts")),
          content: [{ type: "diff", path: NodePath.join(outside, "b.ts") }],
        },
        root,
      ),
    ).toBe(false);
    expect(antigravityEditTargetsInWorkspace(edit(root), root)).toBe(false);
  });

  it("asks when a link precedes a parent segment, since the filesystem follows the link first", () => {
    // `<root>/escape` links outside; `<root>/escape/../x` opens `<outside's parent>/x`.
    expect(
      antigravityEditTargetsInWorkspace(
        { kind: "edit", title: "write_to_file", locations: [{ path: `${root}/escape/../x.ts` }] },
        root,
      ),
    ).toBe(false);
    expect(
      antigravityEditTargetsInWorkspace(
        { kind: "edit", title: "write_to_file", locations: [{ path: `${root}/sub/../x.ts` }] },
        root,
      ),
    ).toBe(false);
  });

  it("asks when a path component exists but cannot be resolved as a directory", async () => {
    await fs.writeFile(NodePath.join(root, "plain-file"), "x");
    expect(
      antigravityEditTargetsInWorkspace(
        {
          kind: "edit",
          title: "write_to_file",
          locations: [{ path: NodePath.join(root, "plain-file", "child.ts") }],
        },
        root,
      ),
    ).toBe(false);
  });

  // File links need the symlink privilege on Windows; junctions can't point at files.
  it.skipIf(process.platform === "win32")(
    "asks for a dangling link even when it points at a missing file outside",
    async () => {
      const link = NodePath.join(root, "dangling.md");
      await fs.symlink(NodePath.join(outside, "not-yet.md"), link);
      try {
        const write = (path: string) =>
          antigravityEditTargetsInWorkspace(
            { kind: "edit", title: "write_to_file", locations: [{ path }] },
            root,
          );
        expect(write(link)).toBe(false);
        expect(write(NodePath.join(root, "dangling.md", "child.md"))).toBe(false);
      } finally {
        await fs.rm(link, { force: true });
      }
    },
  );

  it("asks for Git metadata and accepts names that only start with two dots", () => {
    const write = (path: string) =>
      antigravityEditTargetsInWorkspace(
        { kind: "edit", title: "write_to_file", locations: [{ path }] },
        root,
      );
    expect(write(NodePath.join(root, ".git", "hooks", "pre-commit"))).toBe(false);
    expect(write(NodePath.join(root, "vendor", "lib", ".GIT", "hooks", "pre-commit"))).toBe(false);
    expect(write(NodePath.join(root, "vendor", "lib", "gitignore-notes.md"))).toBe(true);
    expect(write(NodePath.join(root, "..notes.md"))).toBe(true);
    expect(write(NodePath.join(root, "new-dir", "new-file.ts"))).toBe(true);
  });
});
