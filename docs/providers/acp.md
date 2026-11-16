# Custom ACP agents

Add a provider instance in Settings → Providers and choose **Custom ACP agent**.
Enter an executable path or command available on PATH. Arguments are a JSON array;
each item is passed literally, including spaces. F5 executes the command directly.
Set up the agent's authentication using its own CLI before starting a thread.

For example, an instance can contain:

```json
{
  "driver": "acp",
  "displayName": "Local agent",
  "enabled": true,
  "config": {
    "command": "/path/to/agent",
    "args": ["--acp"],
    "env": { "AGENT_HOME": "/path/to/agent-home" }
  }
}
```

Use the instance's sensitive environment-variable editor for credentials.
Environment entries on the instance override its config defaults and are isolated
from other configured instances. Changing the command, arguments or environment
replaces that instance through the normal registry lifecycle. Existing project
provider overrides apply to ACP instances as well.

Availability checks use `initialize` only and stop after ten seconds. They never
start an agent session, authenticate, send a prompt, or launch workspace MCP
servers. A successful check means the local command speaks ACP; the agent may
still need its own login before a session can start. Disabled instances are not
probed. No ACP instance is created implicitly.

Once a session starts, model choices come from its model config option. F5 uses
`session/set_config_option` when that option exists, with the older session-model
method as a fallback. The initial **Agent default** keeps the agent's selection.
Configured custom models remain available. Metadata generation uses the same
instance in a temporary workspace and accepts only schema-validated output.

Custom agents share F5's ACP approval handling, streaming, cancellation, resume,
file-access handling and process cleanup. Thread catalog tools are offered only
when the agent advertises HTTP MCP support. Preview and computer automation remain
unverified and unavailable for custom agents.
