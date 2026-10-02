/** Native wrappers and their file-backed runtime dependencies must remain together. */
export const CLI_RUNTIME_EXTERNAL_PREFIXES = [
  "node-pty",
  "@ff-labs/",
  "@anthropic-ai/claude-agent-sdk",
  "node-gyp-build",
  "node-addon-api",
  "bufferutil",
  "utf-8-validate",
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
