# Quick start

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

## Windows build tools

Workspace scripts invoke the installed JavaScript tools through Node directly.
This avoids relying on the unsigned executable launchers Bun generates in
`node_modules/.bin`, which Windows Application Control can block. Bun may report
that rejection only as `bun: unknown error:` before the build starts.

Keep Node.js (24.13.1 or newer) and Bun on `PATH`, then run the usual commands:

```powershell
bun install
bun run build:desktop
bun run start:desktop
```

Windows security settings do not need to change.
