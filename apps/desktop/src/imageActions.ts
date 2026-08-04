import * as FS from "node:fs/promises";
import * as Path from "node:path";

import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import {
  MAX_DOWNLOAD_FILENAME_CHARACTERS,
  sanitizeDownloadFilename,
} from "@t3tools/shared/downloadFilename";

const MAX_DOWNLOAD_COLLISION_ATTEMPTS = 10_000;

export function readDesktopImageActionBytes(rawBytes: unknown): Uint8Array {
  let bytes: Uint8Array;
  if (rawBytes instanceof ArrayBuffer) {
    bytes = new Uint8Array(rawBytes);
  } else if (ArrayBuffer.isView(rawBytes)) {
    bytes = new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  } else {
    throw new Error("F5 received invalid image bytes from the renderer.");
  }

  if (bytes.byteLength === 0) {
    throw new Error("The image attachment is empty.");
  }
  if (bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
    throw new Error("The image attachment exceeds the desktop action size limit.");
  }
  return Uint8Array.from(bytes);
}

function buildCollisionFilename(filename: string, collisionIndex: number): string {
  if (collisionIndex === 0) {
    return filename;
  }

  const extension = Path.extname(filename);
  const stem = extension.length > 0 ? filename.slice(0, -extension.length) : filename;
  const suffix = ` (${collisionIndex})`;
  const extensionCharacters = Array.from(extension);
  const suffixCharacters = Array.from(suffix);
  const availableStemCharacters = Math.max(
    1,
    MAX_DOWNLOAD_FILENAME_CHARACTERS - extensionCharacters.length - suffixCharacters.length,
  );
  return [
    ...Array.from(stem).slice(0, availableStemCharacters),
    ...suffixCharacters,
    ...extensionCharacters,
  ].join("");
}

interface SaveDesktopImageDownloadDependencies {
  mkdir?: typeof FS.mkdir;
  writeFile?: typeof FS.writeFile;
}

export async function saveDesktopImageDownload(
  input: {
    downloadsDirectory: string;
    filename: string;
    bytes: Uint8Array;
  },
  dependencies: SaveDesktopImageDownloadDependencies = {},
): Promise<string> {
  const mkdir = dependencies.mkdir ?? FS.mkdir;
  const writeFile = dependencies.writeFile ?? FS.writeFile;
  const filename = sanitizeDownloadFilename(input.filename, "image");
  await mkdir(input.downloadsDirectory, { recursive: true });

  for (
    let collisionIndex = 0;
    collisionIndex < MAX_DOWNLOAD_COLLISION_ATTEMPTS;
    collisionIndex += 1
  ) {
    const candidatePath = Path.join(
      input.downloadsDirectory,
      buildCollisionFilename(filename, collisionIndex),
    );
    try {
      await writeFile(candidatePath, input.bytes, { flag: "wx" });
      return candidatePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }

  throw new Error("F5 could not choose an available image download filename.");
}
