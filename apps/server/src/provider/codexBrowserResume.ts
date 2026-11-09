/** Host tool: MCP reload must not disconnect the tool requesting the reload. */
export const CODEX_BROWSER_RESUME_TOOL = {
  type: "function" as const,
  name: "browser_resume",
  description:
    "Return to Chrome after native computer work. Call this tool by itself, after other tool calls finish. It releases native control and restarts the supervised browser runtime. On success recreate browser variables and tab handles before using node_repl. Never use it to bypass pause, recovery or consent.",
  inputSchema: {
    type: "object",
    properties: { reason: { type: "string", minLength: 1 } },
    required: ["reason"],
    additionalProperties: false,
  },
};

export function validBrowserResumeArguments(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const args = value as Record<string, unknown>;
  return (
    Object.keys(args).length === 1 &&
    typeof args.reason === "string" &&
    args.reason.trim().length > 0
  );
}
