# Preview browser release validation

Release gates for desktop preview browser, cookie import and SnapShot features. The user guide is
[Preview browser, cookie import and SnapShot](../user/preview-browser.md).

## Release validation

Run `bun run build:desktop` and `bun run test:desktop-smoke` on each platform shipping desktop features. The smoke uses a disposable F5 profile and tests bridge/renderer startup, isolated browser profiles, deletion guards, app API boundaries and quit behavior. Run the packaged artifact on macOS, Linux and Windows before publishing; this macOS development workspace cannot certify the other platforms or OS permission dialogs. Manually check OAuth login, native user agent, browser editing keys, mouse navigation, a synthetic import canceled mid-write, and a permitted SnapShot attachment. Never use a personal browser profile in automated release tests.

## Deferred platforms

Linux and Windows native SnapShot are deferred as allowed by Phase 13: the proposed native dependencies have not passed a license and packaged-size review. Browser profiles and cookie imports remain available on those platforms.

## Test fixtures

Import source and result fixtures are synthetic in automated tests; tests do not import a personal browser.
