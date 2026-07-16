# Provider prerequisites

F5 needs at least one authenticated coding-agent provider on the machine running the F5 server.

## Codex

- Install the [Codex CLI](https://github.com/openai/codex) so `codex` is on your PATH.
- Authenticate it once before running F5, for example:

  ```bash
  codex login
  ```

  Either ChatGPT auth or an API key works — use whichever your Codex install supports.

- F5 starts the provider process via `codex app-server` per session. If `codex` is missing or unauthenticated, session startup will fail with a clear error.

## Claude Code

- F5 runs the Claude executable bundled with the Claude Agent SDK by default; a separate global
  `claude` command is not required for sessions or health checks.
- Authenticate Claude once before running F5. You can use a separately installed
  [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI for the login:

  ```bash
  claude auth login
  ```

- F5 launches Claude sessions through the Claude Agent SDK, which discovers credentials from the standard Claude Code install locations.

## Windows executable overrides

F5 launches provider arguments without a command shell so workspace paths and provider options are
not reinterpreted by `cmd.exe`. Native `.exe`/`.com` executables, JavaScript CLI entry points, and
standard npm Node `.cmd` shims are supported. Arbitrary `.bat`, `.ps1`, and non-Node `.cmd` wrappers
are deliberately rejected; configure the wrapped executable or JavaScript entry point instead.

Custom Claude binary paths are stricter because the Agent SDK uses a direct process launch: use a
directly runnable executable or the Claude CLI JavaScript entry point, not a `.cmd`/`.bat` shim.

## Picking a provider at runtime

The active provider (and model) is picked per thread from the composer. Switching providers doesn't
require restarting the F5 server. F5 starts a fresh provider session on demand when the selected
provider runtime is available and authenticated.
