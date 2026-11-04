/** Native wrappers and their file-backed runtime dependencies must remain together. */
export const CLI_RUNTIME_EXTERNAL_PREFIXES = [
  "node-pty",
  "@ff-labs/",
  "@anthropic-ai/claude-agent-sdk",
  "node-gyp-build",
  "node-addon-api",
  "bufferutil",
  "utf-8-validate",
  "undici",
] as const;
export function isRuntimeExternalCliDependency(id: string): boolean {
  return CLI_RUNTIME_EXTERNAL_PREFIXES.some((prefix) => id.startsWith(prefix));
}
export function selectCliRuntimeExternalDependencies(
  dependencies: Readonly<Record<string, string>>,
) {
  return Object.fromEntries(
    Object.entries(dependencies).filter(([name]) => isRuntimeExternalCliDependency(name)),
  );
}

/** Bun lock keys can be install aliases, while the resolution names the real package. */
export function pinnedCliDependency(
  packages: Readonly<Record<string, readonly unknown[]>>,
  name: string,
): string {
  const resolution = packages[name]?.[0];
  if (typeof resolution !== "string") throw new Error("Missing pinned native dependency: " + name);
  const separator = resolution.lastIndexOf("@");
  if (separator <= 0 || separator === resolution.length - 1)
    throw new Error("Invalid pinned native dependency: " + name);
  return resolution.slice(0, separator) === name
    ? resolution.slice(separator + 1)
    : "npm:" + resolution;
}
