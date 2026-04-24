# Provider prerequisites

F5 needs at least one coding-agent provider CLI installed and authenticated on the machine running the F5 server. You can install both if you want to switch between them.

## Codex

- Install the [Codex CLI](https://github.com/openai/codex) so `codex` is on your PATH.
- Authenticate it once before running F5, for example:

  ```bash
  codex login
  ```

  Either ChatGPT auth or an API key works — use whichever your Codex install supports.

- F5 starts the provider process via `codex app-server` per session. If `codex` is missing or unauthenticated, session startup will fail with a clear error.

## Claude Code

- Install the [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI so `claude` is on your PATH.
- Authenticate it once before running F5:

  ```bash
  claude login
  ```

- F5 launches Claude sessions through the Claude Agent SDK, which discovers credentials from the standard Claude Code install locations.

## Picking a provider at runtime

The active provider (and model) is picked per thread from the composer. Switching providers doesn't require restarting the F5 server — as long as the corresponding CLI is installed and authenticated on the host, F5 will start a fresh provider session on demand.
