const fs = require("node:fs/promises");
const { join } = require("node:path");
const claudeRuntime = require("./verify-claude-runtime.cjs");

// Electron archives can contain 0777 binaries and 0666 resources, whose modes
// electron-builder preserves in both .deb and AppImage artifacts.
async function removeSharedWriteAccess(path) {
  const stats = await fs.lstat(path);
  if (stats.isSymbolicLink()) return;
  if (stats.mode & 0o022) await fs.chmod(path, stats.mode & 0o7755);
  if (!stats.isDirectory()) return;
  // Do not follow symlinks: their targets may be outside the packed app.
  for (const entry of await fs.readdir(path)) {
    await removeSharedWriteAccess(join(path, entry));
  }
}

exports.removeSharedWriteAccess = removeSharedWriteAccess;
exports.default = async (context) => {
  await claudeRuntime.verifyClaudeRuntime(context);
  await removeSharedWriteAccess(context.appOutDir);
};
