import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import JSZip from "jszip";
import { WorkspaceMediaView } from "../WorkspaceMediaView";
import { sanitizeDocumentHtml } from "./DocumentPages";

const files = vi.hoisted(() => new Map<string, string>());
vi.mock("../../nativeApi", async (original) => ({
  ...(await original<typeof import("../../nativeApi")>()),
  readNativeApi: () => ({
    projects: {
      issueAssetUrl: async (input: { files: { relativePath: string }[] }) =>
        input.files.map(({ relativePath }) => ({ url: files.get(relativePath) })),
    },
  }),
}));
vi.mock("../../lib/serverHttpOrigin", () => ({ getServerHttpOrigin: () => "" }));
const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const src of files.values()) URL.revokeObjectURL(src);
  files.clear();
});
async function open(name: string, data: BlobPart, type = "application/octet-stream") {
  files.set(name, URL.createObjectURL(new Blob([data], { type })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(
    <QueryClientProvider client={client}>
      <div style={{ height: 600, width: 800, display: "flex" }}>
        <WorkspaceMediaView name={name} identity={{ kind: "attachments" }} />
      </div>
    </QueryClientProvider>,
  );
  cleanups.push(
    () => client.clear(),
    () => view.unmount(),
  );
  return view;
}
it("virtualizes large text and delimited data in real workers", async () => {
  await open(
    "rows.csv",
    "name,value\n" + Array.from({ length: 50_000 }, (_, i) => `item-${i},${i}`).join("\n"),
  );
  await vi.waitFor(
    () => expect(document.querySelector('[role="table"][aria-label="rows.csv"]')).not.toBeNull(),
    { timeout: 15_000 },
  );
  await vi.waitFor(() =>
    expect(
      document
        .querySelector('[role="table"][aria-label="rows.csv"]')!
        .getAttribute("aria-rowcount"),
    ).toBe("50001"),
  );
  expect(document.querySelectorAll('[role="row"]').length).toBeLessThan(200);
});
it("renders saved notebook outputs and strips active HTML", async () => {
  await open(
    "book.ipynb",
    JSON.stringify({
      nbformat: 4,
      metadata: {},
      cells: [
        { cell_type: "markdown", source: ["# Notebook title"], outputs: [] },
        {
          cell_type: "code",
          source: ["print(1)"],
          outputs: [{ output_type: "stream", text: ["1\n"] }],
        },
      ],
    }),
  );
  await vi.waitFor(() => expect(document.body.textContent).toContain("Notebook title"), {
    timeout: 15_000,
  });
  expect(document.body.textContent).toContain("Code is never executed");
  expect(
    sanitizeDocumentHtml(
      '<script>alert(1)</script><img src="https://evil.invalid/x"><p onclick="alert(1)">safe</p>',
    ),
  ).toBe("<p>safe</p>");
});
it("opens archive entries with the bounded archive worker", async () => {
  const archive = new JSZip().file("hello.txt", "Hello archive");
  await open("bundle.zip", await archive.generateAsync({ type: "arraybuffer" }));
  await vi.waitFor(() => expect(document.body.textContent).toContain("hello.txt"), {
    timeout: 15_000,
  });
});
it("renders Word document text through the local layout worker", async () => {
  const archive = new JSZip()
    .file(
      "[Content_Types].xml",
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    )
    .file(
      "_rels/.rels",
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    )
    .file(
      "word/document.xml",
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello Word</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>',
    );
  await open("notes.docx", await archive.generateAsync({ type: "arraybuffer" }));
  await vi.waitFor(() => expect(document.body.textContent).toContain("Hello Word"), {
    timeout: 25_000,
  });
});
it("opens SQLite tables in a separate read-only worker", async () => {
  const [{ default: initialize }, { default: wasm }] = await Promise.all([
    import("sql.js"),
    import("sql.js/dist/sql-wasm.wasm?url"),
  ]);
  const SQL = await initialize({ locateFile: () => wasm });
  const database = new SQL.Database();
  database.run("CREATE TABLE people(name TEXT); INSERT INTO people VALUES ('Ada');");
  const data = database.export();
  database.close();
  await open("people.sqlite", new Uint8Array(data).buffer);
  await vi.waitFor(() => expect(document.body.textContent).toContain("Ada"), { timeout: 15_000 });
});
it("previews OpenDocument text in an inert document", async () => {
  const archive = new JSZip().file(
    "content.xml",
    '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>Hello document</text:p></office:text></office:body></office:document-content>',
  );
  await open("notes.odt", await archive.generateAsync({ type: "arraybuffer" }));
  await vi.waitFor(() => expect(document.querySelector("iframe")).not.toBeNull(), {
    timeout: 15_000,
  });
  const frame = document.querySelector("iframe")!;
  expect(frame.getAttribute("sandbox")).toBe("");
  expect(frame.srcdoc).toContain("Hello document");
});
it("keeps a download available when a decoded image is invalid", async () => {
  await open("broken.tiff", "broken");
  await vi.waitFor(() => expect(document.body.textContent).toContain("TIFF"), { timeout: 15_000 });
  expect(document.querySelector("button")?.textContent).toContain("Download broken.tiff");
});
