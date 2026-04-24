import { normalizeHostCompatibleRuntimeSlashCommandName } from "@t3tools/shared/slashCommands";

export interface SupportedSlashCommand {
  readonly name: string;
  readonly description: string;
  readonly argumentHint?: string;
}

export type NormalizedSupportedSlashCommand = Readonly<SupportedSlashCommand>;

export function normalizeSupportedSlashCommands(
  commands: ReadonlyArray<SupportedSlashCommand>,
): ReadonlyArray<NormalizedSupportedSlashCommand> {
  return commands
    .flatMap((command) => {
      const name =
        typeof command.name === "string"
          ? normalizeHostCompatibleRuntimeSlashCommandName(command.name)
          : undefined;
      const description = typeof command.description === "string" ? command.description.trim() : "";
      const argumentHint =
        typeof command.argumentHint === "string" && command.argumentHint.trim().length > 0
          ? command.argumentHint.trim()
          : undefined;
      if (!name || description.length === 0) {
        return [];
      }
      return [
        {
          name,
          description,
          ...(argumentHint ? { argumentHint } : {}),
        },
      ];
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export function fingerprintSupportedSlashCommands(
  normalizedCommands: ReadonlyArray<NormalizedSupportedSlashCommand>,
): string {
  // normalizeSupportedSlashCommands builds fresh command objects with a fixed
  // key insertion order, so JSON.stringify stays stable for equivalent lists.
  // If new optional fields are added here, they must also be normalized with
  // deterministic key emission to preserve that invariant.
  return JSON.stringify(normalizedCommands);
}
