import { createReadStream } from "node:fs";
import { Utf8Lines } from "@t3tools/shared/utf8Lines";

/** A crashed append's unterminated tail cannot establish repair evidence. */
export async function* readCompleteLogLines(file: string): AsyncGenerator<string> {
  const input = createReadStream(file);
  const lines = new Utf8Lines();
  try {
    for await (const chunk of input) yield* lines.push(chunk);
    // Deliberately do not finish(): it emits an unterminated final record.
  } finally {
    input.destroy();
  }
}
