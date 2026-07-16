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
