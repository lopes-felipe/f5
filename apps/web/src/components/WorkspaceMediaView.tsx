import { AssetDocumentContext } from "./AssetDocumentContext";
import { AssetTextView } from "./AssetTextView";
import { isElectron } from "../env";
import { useRightPanelStore } from "../rightPanelStore";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ProjectId, ThreadId, ProjectIssueAssetUrlInput } from "@t3tools/contracts";
import { isImagePreviewPath } from "@t3tools/shared/filePreview";
import { readNativeApi } from "../nativeApi";
import { getServerHttpOrigin } from "../lib/serverHttpOrigin";

export function workspaceMediaKind(
  name: string,
): "image" | "html" | "pdf" | "video" | "audio" | "binary" | null {
  const extension = name.split(".").at(-1)?.toLowerCase();
  if (isImagePreviewPath(name)) return "image";
  if (["html", "htm"].includes(extension ?? "")) return "html";
  if (extension === "pdf") return "pdf";
  if (["mp4", "webm", "mov"].includes(extension ?? "")) return "video";
  if (["mp3", "wav", "ogg", "m4a"].includes(extension ?? "")) return "audio";
  if (
    [
      "zip",
      "gz",
      "tar",
      "7z",
      "exe",
      "dll",
      "bin",
      "docx",
      "xlsx",
      "heic",
      "heif",
      "woff",
      "woff2",
      "ttf",
      "otf",
    ].includes(extension ?? "")
  )
    return "binary";
  return null;
}

export function WorkspaceMediaView({
  name,
  projectId,
  threadId,
  identity,
  relativePath = name,
}: {
  name: string;
  projectId?: ProjectId;
  identity?: ProjectIssueAssetUrlInput["identity"];
  relativePath?: string;
  threadId?: ThreadId;
}) {
  const kind = workspaceMediaKind(name) ?? "binary";
  const [source, setSource] = useState(false);
  const isMarkdown = /\.(md|markdown)$/iu.test(name);
  const isText = isMarkdown || /\.(txt|json|csv|css|js|ts|log)$/iu.test(name);
  const [actualSize, setActualSize] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const grant = useQuery({
    queryKey: ["workspace-media", identity, projectId, threadId, relativePath],
    queryFn: async () => {
      const api = readNativeApi();
      if (!api) throw new Error("Disconnected from server");
      const results = await api.projects.issueAssetUrl({
        identity:
          identity ??
          (threadId ? { kind: "thread", threadId } : { kind: "project", projectId: projectId! }),
        files: [{ relativePath, grant: kind === "html" ? "html-document" : "file" }],
      });
      if (!results[0]) throw new Error("File is unavailable");
      return `${getServerHttpOrigin()}${results[0].url}`;
    },
    staleTime: 25 * 60 * 1000,
    refetchInterval: 25 * 60 * 1000,
  });
  if (grant.isError)
    return (
      <div role="alert" className="p-4">
        Unable to open this file. <button onClick={() => void grant.refetch()}>Retry</button>
      </div>
    );
  if (!grant.data) return <div className="p-4">Loading file…</div>;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-2">
      {actionError && <p role="alert">{actionError}</p>}
      {kind === "html" && isElectron && threadId && (
        <button
          className="self-end underline"
          onClick={() => {
            const api = readNativeApi();
            if (!api) return;
            void api.projects
              .openHtmlPreview({ identity: identity ?? { kind: "thread", threadId }, relativePath })
              .then(async ({ url }) => {
                await api.preview.open({ threadId, url });
                useRightPanelStore.getState().open(threadId, "preview");
              })
              .catch((error: unknown) =>
                setActionError(error instanceof Error ? error.message : "Unable to open preview"),
              );
          }}
        >
          Open in preview browser
        </button>
      )}
      {identity?.kind === "attachments" && (kind === "html" || isMarkdown) && (
        <button className="self-end underline" onClick={() => setSource(!source)}>
          {source ? "Preview" : "Source"}
        </button>
      )}
      {(isText || (kind === "html" && source)) && (
        <AssetDocumentContext.Provider
          value={{
            identity:
              identity ??
              (threadId
                ? { kind: "thread", threadId }
                : { kind: "project", projectId: projectId! }),
            relativePath,
          }}
        >
          <AssetTextView url={grant.data} markdown={isMarkdown && !source} />
        </AssetDocumentContext.Provider>
      )}
      {kind === "binary" && !isText && (
        <div className="p-4">
          <p>Binary file</p>
          <a className="underline" href={grant.data} target="_blank" rel="noreferrer">
            Download {name}
          </a>
          {isElectron && projectId && threadId && (
            <button
              className="ml-3 underline"
              onClick={() => {
                void readNativeApi()
                  ?.shell.revealInFileManager({
                    projectId,
                    threadId,
                    relativePath,
                    kind: "file",
                  })
                  .catch((error: unknown) =>
                    setActionError(
                      error instanceof Error ? error.message : "Unable to reveal file",
                    ),
                  );
              }}
            >
              Reveal
            </button>
          )}
        </div>
      )}

      {kind === "image" && (
        <>
          <button className="self-end" onClick={() => setActualSize(!actualSize)}>
            {actualSize ? "Fit" : "Actual size"}
          </button>
          <img
            alt={name}
            src={grant.data}
            referrerPolicy="no-referrer"
            className={
              actualSize ? "max-w-none self-start" : "max-h-full max-w-full object-contain"
            }
          />
        </>
      )}
      {((kind === "html" && !source) || kind === "pdf") && (
        <iframe
          title={name}
          src={grant.data}
          sandbox={kind === "html" ? "" : undefined}
          referrerPolicy="no-referrer"
          className="min-h-96 flex-1 border-0"
        />
      )}
      {kind === "video" && (
        <video key={name} src={grant.data} controls preload="metadata" className="max-h-full" />
      )}
      {kind === "audio" && <audio src={grant.data} controls preload="metadata" />}
    </div>
  );
}
