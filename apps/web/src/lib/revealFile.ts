import { readNativeApi } from "../nativeApi";
import { toastManager } from "../components/ui/toast";
import { resolveFilePreviewTarget } from "./filePreviewTarget";
import type { ProjectId, ThreadId } from "@t3tools/contracts";

export async function revealFile(
  filePath: string,
  workspaceRoot: string | undefined,
  context: { projectId: ProjectId; threadId: ThreadId },
): Promise<void> {
  try {
    const api = readNativeApi();
    if (!api) throw new Error("File manager is unavailable.");
    const target = resolveFilePreviewTarget(filePath, workspaceRoot);
    if (!target) throw new Error("Unable to resolve the local file path.");
    if (typeof window !== "undefined" && window.desktopBridge?.revealFile) {
      await window.desktopBridge.revealFile(
        `${target.cwd.replace(/[\\/]$/u, "")}/${target.relativePath}`,
      );
      return;
    }
    await api.shell.revealInFileManager({
      ...context,
      ...(target.readOnly ? { cwd: target.cwd } : {}),
      relativePath: target.relativePath,
      kind: "file",
    });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Unable to reveal file",
      description: `${filePath}: ${error instanceof Error ? error.message : "An error occurred."}`,
    });
  }
}
