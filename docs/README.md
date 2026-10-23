# F5 documentation

Start with **Use F5** if you run F5. **Configure & operate** covers installs, providers and hosting.
**Develop F5** is for contributors. These docs track the current source checkout, so the latest
packaged release may lag behind them.

## Use F5

| Guide                                                                        | What it covers                                                         |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [Getting started](user/getting-started.md)                                   | Add a project, pick a model, start a thread, review changes            |
| [Threads and workspaces](user/threads-and-workspaces.md)                     | The composer, queue, panels, diffs, rewind and Git                     |
| [Workflows](user/workflows.md)                                               | Feature, Code Review, Investigation and Document runs                  |
| [Worktrees and storage automation](user/worktrees-and-storage-automation.md) | Worktrees, sending to several models, recovery and cleanup             |
| [Agent tools](user/agent-tools.md)                                           | MCP servers, skills, inventories, memory and the Agents panel          |
| [Attachments and media](user/attachments-and-media.md)                       | Images, files and folders in the composer                              |
| [Usage and limits](user/usage-limits.md)                                     | Recorded activity, account limits and cost                             |
| [Project settings](user/project-settings.md)                                 | Per-project overrides and checked-in defaults                          |
| [PR Hub and forges](user/pr-hub-forges.md)                                   | Pull requests from GitHub, GitLab, Bitbucket, Azure DevOps and Forgejo |
| [Upstream ports](user/upstream-ports.md)                                     | Triage and port changes from the repository you forked                 |
| [Preview browser](user/preview-browser.md)                                   | Browser profiles, cookie import and SnapShot                           |
| [Agent browser and computer use](user/agent-browser-and-computer-use.md)     | Let agents drive the preview browser and macOS apps                    |
| [Standalone CLI](user/standalone-cli.md)                                     | Run F5 as a server without the desktop app                             |
| [Keybindings](../KEYBINDINGS.md)                                             | Default shortcuts and how to change them                               |

## Configure & operate

| Page                                                | What it covers                                         |
| --------------------------------------------------- | ------------------------------------------------------ |
| [Install F5](install.md)                            | Desktop downloads, availability, upgrades and updates  |
| [Provider prerequisites](provider-prerequisites.md) | Install, sign in to and update all seven providers     |
| [Claude](providers/claude.md)                       | Accounts, OpenRouter, Claude Code Router, presets      |
| [Codex](providers/codex.md)                         | Accounts, Codex homes, profiles                        |
| [Antigravity](providers/antigravity.md)             | Antigravity setup and isolation                        |
| [Custom ACP agents](providers/acp.md)               | Local ACP commands, models and initialization checks   |
| [Muse Code](providers/muse.md)                      | Muse Code setup and modes                              |
| [Runtime modes](runtime-modes.md)                   | The four permission modes and provider support         |
| [Project configuration](project-configuration.md)   | The checked-in `f5.json` file                          |
| [Profiles](profiles.md)                             | Separate F5 profiles with their own state and accounts |
| [Remote access](../REMOTE.md)                       | Run F5 on another machine                              |
| [Environment variables](environment.md)             | Every supported variable                               |

F5 stores state under `~/.f5` (`%USERPROFILE%\.f5` on Windows). Use `F5_HOME` and `F5_STATE_DIR`
to override it. The inherited `T3CODE_*` variables still work; see [`NOTICE.md`](../NOTICE.md).

## Develop F5

| Page                                              | What it covers                                          |
| ------------------------------------------------- | ------------------------------------------------------- |
| [Quick start](quick-start.md)                     | Dev, build and packaging commands                       |
| [Workspace layout](workspace-layout.md)           | One line per package                                    |
| [Architecture](architecture.md)                   | Runtime, orchestration and persistence                  |
| [Provider architecture](provider-architecture.md) | WebSocket protocol and the provider adapter contract    |
| [Protocol versioning](protocol-versioning.md)     | Client/server compatibility rules                       |
| [Reliability](reliability.md)                     | Restarts, retries and recovery                          |
| [Performance](performance.md)                     | Performance baseline and budgets                        |
| [Agent browser reference](agent-browser.md)       | Technical reference for browser and computer automation |
| [Agent Bridge](agent-bridge.md)                   | Internal reference for the hidden Agent Bridge and Bots |
| [Scripts](scripts.md)                             | Repository scripts, including screenshot capture        |
| [CI quality gates](ci.md)                         | What CI checks                                          |
| [Releasing F5](release.md)                        | Release process and CLI archives                        |
| [Encyclopedia](encyclopedia.md)                   | Glossary of domain terms                                |
| [Design direction](design/direction.md)           | Visual and interaction direction                        |

```
├── apps/
│   ├── desktop     # Electron app (primary distribution)
│   ├── server      # Node.js server; npm package "t3", binaries f5 and t3
│   ├── web         # React 19 / Vite frontend
│   └── marketing   # Astro marketing site
├── packages/
│   ├── contracts   # Shared Effect-Schema types
│   ├── effect-acp  # Agent Client Protocol client (Effect)
│   └── shared      # Shared runtime utilities
└── scripts/        # Dev runner, build helpers, release tooling
```

See also [`ARCHITECTURE.md`](../ARCHITECTURE.md), [`CHANGELOG.md`](../CHANGELOG.md),
[`SECURITY.md`](../SECURITY.md) and [`CONTRIBUTING.md`](../CONTRIBUTING.md).

### Screenshots

Images in [`images/`](images/) and `assets/screenshots/` are generated. After a UI change, run:

```bash
bun run screenshots:capture                                     # every shot
bun run screenshots:capture -- --only usage-activity,settings-providers
```

The script seeds demo data into a temporary profile, starts an isolated server and captures the
README shots plus the docs shots listed in
[`scripts/docs-screenshots.manifest.ts`](../scripts/docs-screenshots.manifest.ts).

## Evidence archive

[`reviews/`](reviews/) holds validation logs, release notes and review records. They document how
features were verified; they are not instructions.

- [Claude provider release notes](reviews/claude-provider-releases.md)
- [Codex provider release notes](reviews/codex-provider-releases.md)
- [Agent browser validation](reviews/agent-browser-validation.md)
- [Preview browser release validation](reviews/preview-browser-release-validation.md)
- [Server performance and storage validation](reviews/server-performance-storage-validation.md)
- [Profiles review](reviews/profiles-review.md) and [verification](reviews/profiles-verification.md)
- [`computer-certification/`](computer-certification/): machine-readable computer-use certification runs
