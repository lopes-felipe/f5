import { expect, it } from "vitest";
import JSZip from "jszip";
import { openDocument, openNotebook, openRtf } from "./extendedDocumentPreview";
import { boundedZip } from "./boundedZip";
const bytes = (text: string) => new TextEncoder().encode(text).buffer;
it("reads saved notebook cells without executing code and bounds unsafe outputs", () => {
  const result = openNotebook(
    bytes(
      JSON.stringify({
        nbformat: 4,
        metadata: { kernelspec: { language: "python" } },
        cells: [
          {
            cell_type: "code",
            source: ["print(1)"],
            outputs: [{ output_type: "stream", text: ["1\n"] }],
          },
        ],
      }),
    ),
  );
  expect(result.type).toBe("notebook");
  if (result.type === "notebook") {
    expect(result.cells[0]!.source).toBe("print(1)");
    expect(result.cells[0]!.outputs[0]!.text).toBe("1\n");
  }
});
it("extracts rich text while omitting executable RTF destinations", () => {
  const result = openRtf(
    bytes(String.raw`{\rtf1\ansi Hello \b world\b0\par Next}{\*\objdata malicious}`),
  );
  expect(JSON.stringify(result)).toContain("Hello");
  expect(JSON.stringify(result)).not.toContain("malicious");
});
it("reads OpenDocument text and confines archive entry names", async () => {
  const archive = new JSZip();
  archive.file(
    "content.xml",
    '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>Hello document</text:p></office:text></office:body></office:document-content>',
  );
  const result = await openDocument(archive, "odt");
  expect(JSON.stringify(result)).toContain("Hello document");
  const bad = new JSZip().file("../secret.txt", "bad");
  const files = await boundedZip(await bad.generateAsync({ type: "arraybuffer" }));
  expect([...files.keys()].some((key) => key.includes(".."))).toBe(false);
  expect(files.get("secret.txt")?.bytes).toEqual(new TextEncoder().encode("bad"));
});
