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

## Antigravity

Enable Antigravity in Settings, explicitly install its pinned runtime, then sign in with Google.
See [Antigravity setup and isolation](providers/antigravity.md). It is disabled by default.

## Muse Code

This is Meta's Muse Code coding CLI, not the Muse personal agent (which has no public API yet;
F5 does not imitate it).

- Install the CLI yourself so `muse` is on your PATH. F5 never runs the installer:

  ```bash
  curl -fsSL https://dev.meta.ai/install.sh | bash
  ```

- Sign in once: run `muse` in a terminal, use `muse auth set`, or set `META_API_KEY` in the
  provider instance's environment. A set `META_API_KEY` takes precedence over a stored browser
  sign-in.
- Muse Code is unavailable in isolated (non-default) profiles. See
  [Muse Code](providers/muse.md).

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

## Updating provider versions

In **Settings → Providers**, **Check now** checks for updates even when **Automatically check for
provider updates** is off. **Refresh** rechecks installation and authentication health. Failed update
checks remain visible and retain the last successfully checked available version. A server rate limit
shows the time when checking can resume.

F5 detects the installation behind each configured executable and keeps its existing source:

- Public-registry global npm installs (including nvm/fnm prefixes) update the exact available package
  version using npm and Node from that installation's prefix, including in commands copied from F5.
  Both the default registry and any package-scoped override are respected; only an effective public
  npm registry is automated.
- Homebrew formulas and casks update through the owning Homebrew installation. Core formulas/casks
  use the Homebrew API for available versions; other taps use their locally available metadata.
- Native Claude and OpenCode installs use their built-in updaters. Claude keeps its `latest` or
  `stable` channel from that instance's effective Claude configuration directory, including a custom
  home path. An unreadable or unrecognized Claude channel requires a manual update.
- Default Claude is **Bundled with F5**. Its version changes with an F5 release; **Open F5 updates**
  opens the application's update settings. There is no independent SDK update button.
- Other installers (including devbox, Bun, Volta, pnpm, and custom npm registries) remain manual.
  The dialog gives installation-specific guidance and **Refresh and verify**. Remote OpenCode servers
  must be updated on their host.

In-app updates run only from the **Default profile**, on macOS and Linux. Isolated profiles display the
correct command to copy and direct you to Default. Windows provides PowerShell commands to copy;
Windows installers are not executed inside F5.

An update can affect other instances, profiles, and terminals sharing the same executable. The dialog
lists other instances on this server using the installation. Finish or stop active work first, and close
terminal sessions using that CLI. F5 stops idle provider sessions before updating; their next turn uses
the normal resume path and launches the updated executable. Only one installation can update at a time.

The update continues if you navigate away or disconnect. F5 re-probes every affected instance after
an attempt and requires a successful probe after the installer finishes to confirm the observed
version, including unchanged or unverified outcomes. Failed
installer output is available on the initiating card until dismissed. Updates and results are not
persisted as an operation history. Shutting down the F5 server terminates the installer process tree;
a partial installation is possible and will be detected by the next health probe.
