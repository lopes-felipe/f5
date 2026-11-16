/** Native wrappers and their file-backed runtime dependencies must remain together. */
export const CLI_RUNTIME_EXTERNAL_PREFIXES = [
  "node-pty",
  "@ff-labs/",
  "@anthropic-ai/claude-agent-sdk",
  "@openai/codex",
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
  const entry = packages[name]?.[0];
  const resolution = typeof entry === "string" ? /^((?:@[^/]+\/)?[^@]+)@(.+)$/.exec(entry) : null;
  if (!resolution) throw new Error("Missing pinned native dependency: " + name);
  return resolution[1] === name ? resolution[2]! : "npm:" + entry;
}
