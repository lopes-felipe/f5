import type { ProjectScriptIcon } from "@t3tools/contracts";
export interface ProjectFileScript {
  name: string;
  command: string;
  icon: ProjectScriptIcon;
}
/** Repository scripts are templates for explicit import, never executable defaults. */
export function parseProjectFileScripts(source: string): ProjectFileScript[] {
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Project configuration must be an object.");
  const scripts = (value as { scripts?: unknown }).scripts;
  if (scripts === undefined) return [];
  if (!Array.isArray(scripts) || scripts.length > 100)
    throw new Error("Expected at most 100 project actions.");
  return scripts.map((script) => {
    if (
      !script ||
      typeof script !== "object" ||
      typeof script.name !== "string" ||
      !script.name.trim() ||
      script.name.length > 1000 ||
      typeof script.command !== "string" ||
      !script.command.trim() ||
      script.command.length > 100_000
    )
      throw new Error("A project action has an invalid name or command.");
    const icon = script.icon ?? "play";
    if (!["play", "test", "lint", "configure", "build", "debug"].includes(icon))
      throw new Error("A project action has an invalid icon.");
    return {
      name: script.name.trim(),
      command: script.command.trim(),
      icon: icon as ProjectScriptIcon,
    };
  });
}
