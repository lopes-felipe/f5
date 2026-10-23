import * as NodeModule from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Loaded before either application bundle. Do not set NODE_COMPILE_CACHE: provider
// and terminal children must retain their own cache policy. AppImage paths move
// on every launch, so caching those paths would accumulate entries without hits.
try {
  if (!process.env.APPIMAGE && typeof NodeModule.enableCompileCache === "function") {
    const root =
      process.platform === "linux"
        ? process.env.XDG_CACHE_HOME || join(homedir(), ".cache")
        : tmpdir();
    NodeModule.enableCompileCache(join(root, "f5", "compile-cache"));
  }
} catch {
  /* An unavailable cache must never prevent startup. */
}
