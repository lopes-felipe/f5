- Each MCP tool can be set to Allow, Ask or Block, with a server default for the rest. Ask shows
  an approval in the conversation before every call, for every agent and mode; when Codex or
  Claude would ask about the same call, you are asked once.
- MCP settings have an Activity tab with recent tool calls, the last day's error rate and latency,
  and the server's stderr. Arguments and results are never stored.
- The chat's MCP details can turn a server off for one conversation, without restarting the agent.
- Stored MCP secrets can be used inside a longer value (`Bearer ${f5-secret:…}`), in arguments and
  in URLs.
