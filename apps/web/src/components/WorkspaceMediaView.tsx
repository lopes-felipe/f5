import { AssetDocumentContext } from "./AssetDocumentContext";
import { AssetTextView } from "./AssetTextView";
import { isElectron } from "../env";
import { useRightPanelStore } from "../rightPanelStore";
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import type { ProjectId, ThreadId, ProjectIssueAssetUrlInput } from "@t3tools/contracts";
import {
  filePreviewKind,
  officePreviewKind,
  type FilePreviewKind,
} from "@t3tools/shared/filePreview";
import { readNativeApi } from "../nativeApi";
import { getServerHttpOrigin } from "../lib/serverHttpOrigin";
const OfficeViewer = lazy(() => import("./files/OfficeViewer"));
const BinaryViewer = lazy(() => import("./files/BinaryViewer"));
const FontViewer = lazy(() => import("./files/FontViewer"));
const MermaidFileViewer = lazy(() => import("./files/MermaidFileViewer"));
const PreviewImage = lazy(() =>
  import("./files/PreviewImage").then((module) => ({ default: module.PreviewImage })),
);

export function workspaceMediaKind(
  name: string,
): Exclude<FilePreviewKind, "text" | "markdown" | "unsupported"> | "binary" | "table" | null {
  const kind = filePreviewKind({ name });
  if (kind === "text" && /\.(csv|tsv)$/iu.test(name)) return "table";
  if (kind === "text" || kind === "markdown") return null;
  return kind === "unsupported" ? "binary" : kind;
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
  const isText = ["markdown", "text"].includes(filePreviewKind({ name }));
  const officeKind = officePreviewKind({ name });
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
      <a className="self-end underline" href={grant.data} download={name}>
        Download {name}
      </a>
      <Suspense fallback={<p role="status">Loading preview…</p>}>
        {officeKind && (
          <OfficeViewer key={grant.data} src={grant.data} name={name} kind={officeKind} />
        )}
        {(kind === "archive" || kind === "sqlite") && (
          <BinaryViewer key={grant.data} src={grant.data} name={name} kind={kind} />
        )}
        {kind === "font" && <FontViewer key={grant.data} src={grant.data} name={name} />}
        {kind === "mermaid" && <MermaidFileViewer key={grant.data} src={grant.data} />}
      </Suspense>
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
          <AssetTextView url={grant.data} name={name} markdown={isMarkdown && !source} />
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
          {/\.(heic|heif|tif|tiff)$/iu.test(name) ? (
            <Suspense fallback={<p>Decoding image…</p>}>
              <PreviewImage key={grant.data} name={name} src={grant.data} />
            </Suspense>
          ) : (
            <img
              alt={name}
              src={grant.data}
              referrerPolicy="no-referrer"
              className={
                actualSize ? "max-w-none self-start" : "max-h-full max-w-full object-contain"
              }
            />
          )}
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
