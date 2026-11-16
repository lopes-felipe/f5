import { previewSecretCollectionScript } from "./snapshotSecrets";
import { previewDebugger } from "./previewDebugger";

export const previewSnapshotChanged = () =>
  new Error("The page changed while capturing its snapshot. Take another snapshot.");

interface FrameTree {
  readonly frame: { readonly id: string; readonly loaderId?: string };
  readonly childFrames?: ReadonlyArray<FrameTree>;
}
interface Reader {
  readonly contextId: number;
  readonly sessionId?: string;
}

const treeStamp = (tree: FrameTree): string => {
  const pending = [tree];
  const entries: Array<[string, string | undefined]> = [];
  while (pending.length) {
    const node = pending.pop()!;
    if (
      typeof node?.frame?.id !== "string" ||
      (node.frame.loaderId !== undefined && typeof node.frame.loaderId !== "string") ||
      entries.length >= 256
    )
      throw previewSnapshotChanged();
    entries.push([node.frame.id, node.frame.loaderId]);
    if (node.childFrames) {
      if (!Array.isArray(node.childFrames) || node.childFrames.length > 256)
        throw previewSnapshotChanged();
      pending.push(...node.childFrames);
    }
  }
  return JSON.stringify(entries);
};

/** One capture owns only its child sessions; the shared root debugger stays attached. */
export function makePreviewSnapshotSecretReader(
  guest: Pick<Electron.WebContents, "mainFrame" | "debugger">,
  checkActive: () => void,
) {
  const children = new Set<string>();
  const readers: Reader[] = [];
  const trees: Array<{ sessionId?: string; stamp: string }> = [];
  let closed = false;
  let opened: Promise<string> | undefined;
  const check = () => {
    checkActive();
    if (closed) throw previewSnapshotChanged();
  };
  const nativeIdentity = () => {
    const frames = guest.mainFrame.framesInSubtree;
    if (!frames.length || frames.length > 256) throw previewSnapshotChanged();
    return JSON.stringify(
      frames.map((frame) => [frame.frameTreeNodeId, frame.processId, frame.frameToken]),
    );
  };
  const send = async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
    check();
    try {
      const result = await previewDebugger(guest).sendCommand(method, params, sessionId);
      check();
      return result;
    } catch {
      throw previewSnapshotChanged();
    }
  };
  const detach = (sessionId: string) => {
    try {
      void previewDebugger(guest)
        .sendCommand("Target.detachFromTarget", { sessionId })
        .catch(() => undefined);
    } catch {
      /* The guest may already have been destroyed. */
    }
  };
  const readValues = async (reader: Reader): Promise<ReadonlyArray<string>> => {
    const { result, exceptionDetails } = await send(
      "Runtime.evaluate",
      {
        contextId: reader.contextId,
        expression: previewSecretCollectionScript,
        returnByValue: true,
      },
      reader.sessionId,
    );
    const values: unknown = result?.value;
    if (
      exceptionDetails ||
      !Array.isArray(values) ||
      values.length > 4096 ||
      values.some((value) => typeof value !== "string" || value.length > 6 * 16_384)
    )
      throw previewSnapshotChanged();
    return values as string[];
  };
  const readTree = async (sessionId?: string) => {
    const { frameTree } = await send("Page.getFrameTree", {}, sessionId);
    const stamp = treeStamp(frameTree);
    return { tree: frameTree as FrameTree, stamp };
  };
  const open = async () => {
    check();
    const identity = nativeIdentity();
    if (!previewDebugger(guest).isAttached()) previewDebugger(guest).attach("1.3");
    const root = await readTree();
    trees.push({ stamp: root.stamp });
    const seen = new Set<string>();
    const attachFrame = async (frameId: string): Promise<void> => {
      const { targetInfo } = await send("Target.getTargetInfo", { targetId: frameId });
      if (targetInfo?.type !== "iframe" || targetInfo.targetId !== frameId)
        throw previewSnapshotChanged();
      // Register even a late attachment so a timeout cannot leak its session.
      const response = await previewDebugger(guest).sendCommand("Target.attachToTarget", {
        targetId: frameId,
        flatten: true,
      });
      const childId: unknown = response?.sessionId;
      if (typeof childId !== "string" || !childId) throw previewSnapshotChanged();
      if (closed) {
        detach(childId);
        throw previewSnapshotChanged();
      }
      children.add(childId);
      check();
      const child = await readTree(childId);
      if (child.tree.frame.id !== frameId) throw previewSnapshotChanged();
      trees.push({ sessionId: childId, stamp: child.stamp });
      await visit(child.tree, childId, true);
    };
    const visit = async (tree: FrameTree, sessionId?: string, ownerRoot = false): Promise<void> => {
      check();
      if (seen.has(tree.frame.id) || seen.size >= 256) throw previewSnapshotChanged();
      try {
        const { executionContextId } = await send(
          "Page.createIsolatedWorld",
          {
            frameId: tree.frame.id,
            worldName: "f5-preview-snapshot",
          },
          sessionId,
        );
        if (!Number.isSafeInteger(executionContextId) || executionContextId <= 0)
          throw previewSnapshotChanged();
        const reader = { contextId: executionContextId, ...(sessionId ? { sessionId } : {}) };
        // Some Chromium builds return a context in the wrong process. Verify
        // that it can actually be evaluated before accepting this owner.
        await readValues(reader);
        readers.push(reader);
        seen.add(tree.frame.id);
      } catch {
        if (ownerRoot) throw previewSnapshotChanged();
        await attachFrame(tree.frame.id);
        return;
      }
      for (const child of tree.childFrames ?? []) await visit(child, sessionId);
    };
    await visit(root.tree, undefined, true);
    if (readers.length < guest.mainFrame.framesInSubtree.length) {
      // Chromium can omit remote frames entirely from a process's Page tree.
      // DOM.getFrameOwner searches only that inspected root's descendants, so
      // it proves ownership before a globally listed iframe target is attached.
      // See InspectorDOMAgent::getFrameOwner in Chromium's inspector_dom_agent.cc.
      const { targetInfos } = await send("Target.getTargets");
      if (!Array.isArray(targetInfos) || targetInfos.length > 1024) throw previewSnapshotChanged();
      const candidates = targetInfos.filter(
        (target) => target?.type === "iframe" && typeof target.targetId === "string",
      );
      if (candidates.length > 256) throw previewSnapshotChanged();
      let progress = true;
      while (progress && readers.length < guest.mainFrame.framesInSubtree.length) {
        progress = false;
        for (const target of candidates) {
          if (seen.has(target.targetId)) continue;
          for (const owner of [undefined, ...children]) {
            check();
            try {
              const { backendNodeId } = await send(
                "DOM.getFrameOwner",
                { frameId: target.targetId },
                owner,
              );
              if (!Number.isSafeInteger(backendNodeId) || backendNodeId <= 0) continue;
            } catch {
              check();
              continue;
            }
            await attachFrame(target.targetId);
            progress = true;
            break;
          }
        }
      }
    }
    if (readers.length !== guest.mainFrame.framesInSubtree.length || nativeIdentity() !== identity)
      throw previewSnapshotChanged();
    return identity;
  };
  return {
    async read(): Promise<ReadonlyArray<ReadonlyArray<string>>> {
      const identity = await (opened ??= open());
      check();
      if (nativeIdentity() !== identity) throw previewSnapshotChanged();
      for (const owner of trees)
        if ((await readTree(owner.sessionId)).stamp !== owner.stamp) throw previewSnapshotChanged();
      const values: Array<ReadonlyArray<string>> = [];
      let characters = 0;
      let count = 0;
      for (const reader of readers) {
        const entries = await readValues(reader);
        for (const value of entries) {
          characters += value.length;
          if (++count > 4096 || characters > 1_048_576) throw previewSnapshotChanged();
        }
        values.push(entries);
      }
      if (nativeIdentity() !== identity) throw previewSnapshotChanged();
      return values;
    },
    close() {
      closed = true;
      for (const sessionId of children) detach(sessionId);
      children.clear();
    },
  };
}
