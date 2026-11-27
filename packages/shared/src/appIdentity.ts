/**
 * The packaged app's bundle id on macOS and AppUserModelID on Windows. The desktop build
 * passes it to electron-builder as `appId`, and the Dock tile plug-in names the
 * notification it listens for after the real bundle id, so it is written only here.
 */
export const APP_BUNDLE_ID = "io.github.lopesfelipe.f5";
