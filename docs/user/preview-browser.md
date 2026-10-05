# Preview browser, cookie import and SnapShot

F5 desktop keeps browser profiles separate from F5 profiles. New browser partitions include both IDs; the default browser profile keeps the legacy partition so upgrades preserve logins. persistent profiles survive restarts, and incognito profiles are omitted from the on-disk registry. The registry is `preview-browser-profiles.json` in the owning F5 profile's state directory. Integrations settings can create, select, and delete profiles. The persistent selection is remembered for future windows and restarts. Each open window keeps its own selection. Selection applies to new tabs; existing tabs keep their partition. Close a profile's tabs before deleting it. Deletion clears its cookies, storage and cache before removing metadata.

Integrations settings also choose the link target and new-tab defaults. Chat links and PR actions use the selected target when a thread is available; without a thread they use the system browser. Remote web always opens the local system browser. Browser tabs have independent zoom, mute and context menus. Editing keys belong to the browser guest. Mouse thumb buttons navigate the owning guest only. OAuth `new-window` popups use a sandboxed child of the owning window, the same browser session, and a 520×720 initial size. Other links follow the selected target; children cannot create further popups. Guest pages receive no F5 API bridge or application authorization.

The server-owned **Enable agent browser access** setting can be overridden per project. Disabling it prevents new Codex preview MCP sessions and rejects subsequent automation requests, including requests from an already-running agent. Tabs created by automation require confirmation before a user closes them. Screenshots and recording initialization recover from capture timeouts; screenshot dimensions are capped at 2,560 pixels and encoded screenshots at 25 MiB.

## Import cookies

Close the source browser and choose its source profile in Integrations settings. Import supports Chromium-family browsers, Firefox and macOS Safari. Chromium uses macOS Keychain, Linux's `secret-tool` credential store, or standard Windows DPAPI/AES-GCM encryption. Windows app-bound (`v20`) encryption is unsupported. Firefox containers and partitioned cookies are skipped. Safari may need **Full Disk Access** for F5 in System Settings; the wizard links to the permission pane and can recheck prerequisites.

Every import creates an unpublished staging profile. Source SQLite files and their WAL journals are copied into private temporary directories and opened read-only with `node:sqlite`; handles close and copies are removed. Source databases are never modified. Host-only cookies omit the domain when written to Electron, preserving `__Host-` scope. Progress reports imported, skipped and failed counts. Cookie values never enter errors or logs.

Cancel clears the staging partition and leaves existing profiles untouched. A successful import flushes cookies before publishing the profile. The staging journal clears abandoned partitions after a restart. Interrupted imports can be retried into a new profile. Import source and result fixtures are synthetic in automated tests; tests do not import a personal browser.

## SnapShot (macOS)

Enable the global shortcut in Integrations settings; the default is **Alt+Shift+Command+S**. Grant **Screen Recording** access to F5 first. **Accessibility** is optional and supplies text only from the uniquely matching captured window; other windows are excluded. SnapShot finds the frontmost non-F5 window, captures it without a shadow, downscales it to at most 2,560 pixels, and reads up to 2,000 accessibility nodes with a three-second timeout and a 20,000-character text limit. It focuses F5 and puts `window.png` and `window-context.txt` into the current or most recently visited thread's composer through the normal upload path. It preserves the draft and never submits a turn. Captures made before opening a thread wait in a bounded in-memory inbox until a thread is selected.

Linux and Windows native SnapShot are deferred as allowed by Phase 13: the proposed native dependencies have not passed a license and packaged-size review. Browser profiles and cookie imports remain available on those platforms.

## Release validation

Run `bun run build:desktop` and `bun run test:desktop-smoke` on each platform shipping desktop features. The smoke uses a disposable F5 profile and tests bridge/renderer startup, isolated browser profiles, deletion guards, app API boundaries and quit behavior. Run the packaged artifact on macOS, Linux and Windows before publishing; this macOS development workspace cannot certify the other platforms or OS permission dialogs. Manually check OAuth login, native user agent, browser editing keys, mouse navigation, a synthetic import canceled mid-write, and a permitted SnapShot attachment. Never use a personal browser profile in automated release tests.
