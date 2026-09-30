import { setAttachmentSource } from "./attachmentUploadQueue";
export function foldedPasteFile(
  text: string,
  currentText: string,
  maxInputChars: number,
  names: readonly string[],
): File | null {
  if (
    new TextEncoder().encode(text).byteLength < 32 * 1024 &&
    currentText.length + text.length <= maxInputChars
  )
    return null;
  let name = "pasted-text.txt";
  for (let index = 2; names.includes(name); index++) name = `pasted-text-${index}.txt`;
  return setAttachmentSource(new File([text], name, { type: "text/plain" }), "pasted-text");
}
