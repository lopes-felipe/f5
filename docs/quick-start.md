# Quick start

Run `bun install --frozen-lockfile` from the repository root before using these
commands, including after pulling changes or switching branches with different dependencies.

```bash
# Development (with hot reload)
bun run dev

# Desktop development
bun run dev:desktop

# Desktop development on an isolated port set
F5_DEV_INSTANCE=feature-xyz bun run dev:desktop

# Production
bun run build
bun run start

# Build a shareable macOS .dmg (arm64 by default)
bun run dist:desktop:dmg

# Build a Linux x64 AppImage
bun run dist:desktop:linux

# Build a Windows x64 NSIS installer
bun run dist:desktop:win

# Or from any project directory after publishing:
npx t3
```

## Updating a source checkout

```bash
git pull --ff-only
bun install --frozen-lockfile
bun run start:desktop
```

Pulling source changes does not update `node_modules`. The desktop build checks
for missing dependencies before invoking the build tools and lists any missing
packages with the command to reinstall. You can also run `bun run check:dependencies`
directly. This check detects missing packages; run the install command after updating
even if the check passes, so installed versions match the lockfile.

## Windows build tools

Workspace scripts invoke the installed JavaScript tools through Node directly.
This avoids relying on the unsigned executable launchers Bun generates in
`node_modules/.bin`, which Windows Application Control can block. Bun may report
that rejection only as `bun: unknown error:` before the build starts.

Keep Node.js (24.13.1 or newer) and Bun on `PATH`, then run the usual commands:

```powershell
bun install --frozen-lockfile
bun run build:desktop
bun run start:desktop
```

Windows security settings do not need to change.
