# F5 for iPhone

Use Xcode 27, CocoaPods, and the repository’s pinned Node and Bun versions.

```sh
F5_SKIP_ELECTRON_INSTALL=1 bun install --frozen-lockfile
F5_IOS_PERSONAL_TEAM=1 bun run --cwd apps/mobile ios:dev
```

Personal Team builds omit the push entitlement. Start Metro with `F5_IOS_PERSONAL_TEAM=1 bun run --cwd apps/mobile dev` for those builds. For a development build with push, use a paid Apple team and its sandbox APNs key. Set `F5_IOS_BUNDLE_ID` for your own App ID.

`bun run --cwd apps/mobile check:bundle` checks the iOS bundle for imports from Node or other apps. `bun run --cwd apps/mobile test` runs the core tests without Xcode.

See the [Phone access guide](../../docs/user/mobile.md) for host setup, TestFlight signing, and the physical-device checklist.
