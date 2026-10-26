import type {
  ProjectSkill,
  ServerProviderSkill,
  ServerProvider,
  CompactRuntimeConfiguredActivityPayload,
  ProviderKind,
  UserMessageSkillCall,
} from "@t3tools/contracts";
type ComposerCommandItem =
  | {
      id: string;
      type: "slash-command";
      command: "model" | "plan" | "default";
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "skill";
      name: string;
      label: string;
      description: string;
      argumentHint: string | null;
      source: "session" | "instance" | "project";
    };
export const HOST_LOCAL_SLASH_COMMAND_NAMES = ["model", "plan", "default"] as const;

const HOST_LOCAL_SLASH_COMMAND_NAME_SET = new Set<string>(HOST_LOCAL_SLASH_COMMAND_NAMES);
const HOST_COMPATIBLE_RUNTIME_SLASH_COMMAND_NAME_PATTERN = /^[a-z0-9]+(?:[-:][a-z0-9]+)*$/;

export function isReservedHostLocalSlashCommandName(value: string): boolean {
  return HOST_LOCAL_SLASH_COMMAND_NAME_SET.has(value.trim().toLowerCase());
}

export function normalizeHostCompatibleRuntimeSlashCommandName(value: string): string | undefined {
  const normalized = value.trim().replace(/^\/+/, "");
  if (!HOST_COMPATIBLE_RUNTIME_SLASH_COMMAND_NAME_PATTERN.test(normalized)) {
    return undefined;
  }
  if (isReservedHostLocalSlashCommandName(normalized)) {
    return undefined;
  }
  return normalized;
}

const HOST_LOCAL_SLASH_COMMAND_ITEMS = [
  {
    id: "slash:model",
    type: "slash-command",
    command: "model",
    label: "/model",
    description: "Switch response model for this thread",
  },
  {
    id: "slash:plan",
    type: "slash-command",
    command: "plan",
    label: "/plan",
    description: "Switch this thread into plan mode",
  },
  {
    id: "slash:default",
    type: "slash-command",
    command: "default",
    label: "/default",
    description: "Switch this thread back to normal chat mode",
  },
] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;

function normalizeComposerInsertedSkillName(value: string): string {
  return value.trim().replace(/^\/+/, "");
}

type RuntimeSlashCommands = NonNullable<CompactRuntimeConfiguredActivityPayload["slashCommands"]>;

/**
 * Native commands for the composer: the live session's catalog when the
 * thread's session belongs to the selected instance, otherwise the selected
 * instance's own (private) catalog. Switching instance therefore drops the
 * previous instance's commands instead of mixing two private catalogs.
 */
export function resolveComposerNativeSlashCommands(input: {
  readonly runtimeSlashCommands: RuntimeSlashCommands | null | undefined;
  readonly sessionInstanceId: string | null | undefined;
  readonly selectedInstanceId: string | null | undefined;
  readonly instanceSlashCommands: ServerProvider["slashCommands"] | null | undefined;
}): { readonly commands: RuntimeSlashCommands; readonly source: "session" | "instance" } {
  const sessionMatches =
    !input.sessionInstanceId ||
    !input.selectedInstanceId ||
    input.sessionInstanceId === input.selectedInstanceId;
  if (input.runtimeSlashCommands && sessionMatches) {
    return { commands: input.runtimeSlashCommands, source: "session" };
  }
  return {
    commands: (input.instanceSlashCommands ?? []).map((command) => ({
      name: command.name,
      description: command.description ?? `Run /${command.name}`,
      ...(command.input?.hint ? { argumentHint: command.input.hint } : {}),
    })),
    source: "instance",
  };
}

export function buildSlashComposerMenuItems(input: {
  query: string;
  runtimeSlashCommands?: RuntimeSlashCommands | null | undefined;
  /** Where `runtimeSlashCommands` came from; defaults to the live session. */
  runtimeSlashCommandsSource?: "session" | "instance";
  provider?: ProviderKind | null | undefined;
  projectSkills?: ReadonlyArray<ProjectSkill> | null | undefined;
  providerSkills?: ReadonlyArray<ServerProviderSkill> | undefined;
}): Array<Extract<ComposerCommandItem, { type: "slash-command" | "skill" }>> {
  const seenSkillNames = new Set<string>();
  const runtimeSource = input.runtimeSlashCommandsSource ?? "session";
  const runtimeSkillItems: Array<Extract<ComposerCommandItem, { type: "skill" }>> = (
    input.runtimeSlashCommands ?? []
  ).flatMap((command) => {
    const name = normalizeHostCompatibleRuntimeSlashCommandName(command.name);
    // Host-reserved commands (/model, /plan, /default) stay F5's.
    if (!name || isReservedHostLocalSlashCommandName(name) || seenSkillNames.has(name)) {
      return [];
    }
    seenSkillNames.add(name);
    return [
      {
        id: `skill:runtime:${name}`,
        type: "skill" as const,
        name,
        label: `/${name}`,
        description: command.description,
        argumentHint: command.argumentHint ?? null,
        source: runtimeSource,
      },
    ];
  });

  const projectSkillItems: Array<Extract<ComposerCommandItem, { type: "skill" }>> = (
    input.provider ? (input.projectSkills ?? []) : []
  )
    .map((skill) => (input.provider ? (skill.providerVariants?.[input.provider] ?? skill) : skill))
    .filter(
      (skill) => skill.paths.length === 0 && (input.provider === "claudeAgent" || skill.sourcePath),
    )
    .flatMap((skill) => {
      const name = normalizeHostCompatibleRuntimeSlashCommandName(skill.commandName);
      if (!name || isReservedHostLocalSlashCommandName(name) || seenSkillNames.has(name)) {
        return [];
      }
      // Native (session/instance) commands are authoritative when both sources
      // publish the same menu name, so project skills only fill unclaimed names.
      seenSkillNames.add(name);
      return [
        {
          id: `skill:project:${name}`,
          type: "skill" as const,
          name,
          label: `/${name}`,
          description: skill.description,
          argumentHint: skill.argumentHint,
          source: "project" as const,
        },
      ];
    });

  // Instance skills only fill names neither native commands nor project files claimed.
  const providerSkillItems = (input.providerSkills ?? []).flatMap((skill) => {
    const name = normalizeHostCompatibleRuntimeSlashCommandName(skill.name);
    if (!skill.enabled || !name || seenSkillNames.has(name)) return [];
    seenSkillNames.add(name);
    return [
      {
        id: `skill:provider:${name}`,
        type: "skill" as const,
        name,
        label: `/${name}`,
        description: skill.description ?? `Use ${name}`,
        argumentHint: null,
        source: "instance" as const,
      },
    ];
  });
  const query = input.query.trim().toLowerCase();
  const slashItems = [
    ...HOST_LOCAL_SLASH_COMMAND_ITEMS,
    ...runtimeSkillItems,
    ...projectSkillItems,
    ...providerSkillItems,
  ] satisfies Array<Extract<ComposerCommandItem, { type: "slash-command" | "skill" }>>;
  if (!query) {
    return slashItems;
  }
  return slashItems.filter((item) => {
    if (item.type === "slash-command") {
      return (
        item.command.includes(query) ||
        item.label.slice(1).includes(query) ||
        item.description.toLowerCase().includes(query)
      );
    }
    return (
      item.name.includes(query) ||
      item.label.slice(1).includes(query) ||
      item.description.toLowerCase().includes(query)
    );
  });
}

export function buildComposerSkillReplacement(skillName: string, provider?: ProviderKind): string {
  return `${provider === "codex" ? "$" : "/"}${normalizeComposerInsertedSkillName(skillName)} `;
}

export function rewriteComposerRuntimeSkillInvocationForSend(input: {
  text: string;
  provider: ProviderKind | null | undefined;
  runtimeSlashCommands?:
    | CompactRuntimeConfiguredActivityPayload["slashCommands"]
    | null
    | undefined;
  projectSkills?: ReadonlyArray<ProjectSkill> | null | undefined;
  providerSkills?: ReadonlyArray<ServerProviderSkill> | undefined;
}): { text: string; skillCall: UserMessageSkillCall | undefined } {
  const leadingCommandMatch = /^([/$])([^\s/$]+)(?=\s|$)/.exec(input.text);
  if (!leadingCommandMatch) {
    return { text: input.text, skillCall: undefined };
  }

  const leadingCommandName = normalizeHostCompatibleRuntimeSlashCommandName(
    leadingCommandMatch[2] ?? "",
  );
  if (!leadingCommandName) {
    return { text: input.text, skillCall: undefined };
  }

  const knownRuntimeSkillNames = new Set(
    (input.runtimeSlashCommands ?? [])
      .map((command) => normalizeHostCompatibleRuntimeSlashCommandName(command.name))
      .flatMap((name) => (name ? [name] : [])),
  );
  for (const skill of input.providerSkills ?? []) {
    const name = normalizeHostCompatibleRuntimeSlashCommandName(skill.name);
    if (skill.enabled && name) knownRuntimeSkillNames.add(name);
  }
  if (input.provider) {
    for (const skill of input.projectSkills ?? []) {
      if (skill.paths.length > 0 || (input.provider !== "claudeAgent" && !skill.sourcePath)) {
        continue;
      }
      const name = normalizeHostCompatibleRuntimeSlashCommandName(skill.commandName);
      if (name) {
        knownRuntimeSkillNames.add(name);
      }
    }
  }
  if (!knownRuntimeSkillNames.has(leadingCommandName)) {
    return { text: input.text, skillCall: undefined };
  }

  if (leadingCommandMatch[1] === "$" && input.provider !== "codex") {
    return { text: input.text, skillCall: undefined };
  }

  const projectSkill = input.projectSkills
    ?.map((skill) => (input.provider ? (skill.providerVariants?.[input.provider] ?? skill) : skill))
    .find(
      (skill) =>
        skill.commandName === leadingCommandName &&
        skill.paths.length === 0 &&
        (input.provider === "claudeAgent" || skill.sourcePath),
    );
  const nativeKnown =
    input.runtimeSlashCommands?.some((command) => command.name === leadingCommandName) ||
    (!projectSkill &&
      input.providerSkills?.some((skill) => skill.enabled && skill.name === leadingCommandName)) ||
    (input.provider && projectSkill?.nativeProviders?.includes(input.provider)) ||
    (input.provider === "claudeAgent" &&
      (!projectSkill?.sourcePath || /(?:^|\/)\.claude\/skills\//.test(projectSkill.sourcePath)));
  const text =
    input.provider === "codex" && nativeKnown
      ? `$${leadingCommandName}${input.text.slice(leadingCommandMatch[0].length)}`
      : input.text;
  // Old snapshots may still carry an absolute path. Never put it into a transcript.
  const source = projectSkill?.sourcePath;
  const portableSource = source && !/^(?:[A-Za-z]:[\\/]|\/)/.test(source) ? source : undefined;
  const textWithPath =
    projectSkill && !nativeKnown
      ? `${text}\n\nUse the skill instructions ${portableSource ? `at ${JSON.stringify(portableSource)}` : `for ${JSON.stringify(leadingCommandName)}`}.`
      : text;
  return { text: textWithPath, skillCall: { name: leadingCommandName } };
}
