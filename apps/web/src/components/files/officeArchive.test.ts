import JSZip from "jszip";
import { expect, it } from "vitest";

import { prepareOffice } from "./officeArchive";

it.each([
  { behavior: "drops an emoji that would be split", prefixLength: 4095, keptEmoji: "" },
  { behavior: "keeps an emoji that fits exactly", prefixLength: 4094, keptEmoji: "🚀" },
])("$behavior when truncating worksheet text", async ({ prefixLength, keptEmoji }) => {
  const prefix = "a".repeat(prefixLength);
  const archive = new JSZip();
  const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const relationship = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const sheetPath = "xl/worksheets/sheet1.xml";
  archive.file(
    "xl/workbook.xml",
    `<workbook xmlns="${ns}" xmlns:r="${relationship}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  archive.file(
    "xl/_rels/workbook.xml.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${relationship}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
  );
  archive.file(
    sheetPath,
    `<worksheet xmlns="${ns}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${prefix}🚀tail</t></is></c></row></sheetData></worksheet>`,
  );

  const result = await prepareOffice(await archive.generateAsync({ type: "arraybuffer" }), "xlsx");
  const preview = await JSZip.loadAsync(result.bytes);
  const sheetBytes = await preview.file(sheetPath)?.async("uint8array");
  const sheet = new TextDecoder("utf-8", { fatal: true }).decode(sheetBytes);

  expect(result.truncated).toBe(true);
  expect(sheet).toContain(`<t>${prefix}${keptEmoji}</t>`);
});
