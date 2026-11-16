import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  renameSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { copyMacAppBundle } from "./electron-launcher.mjs";

it.skipIf(process.platform === "win32")(
  "keeps copied framework resources usable independently of the source app",
  () => {
    const root = mkdtempSync(join(tmpdir(), "f5-electron-copy-"));
    try {
      const source = join(root, "Electron.app");
      const destination = join(root, "F5.app");
      const framework = "Contents/Frameworks/Electron Framework.framework";
      mkdirSync(join(source, framework, "Versions/A/Resources"), { recursive: true });
      writeFileSync(join(source, framework, "Versions/A/Resources/icudtl.dat"), "fixture ICU data");
      symlinkSync("A", join(source, framework, "Versions/Current"));
      symlinkSync("Versions/Current/Resources", join(source, framework, "Resources"));

      copyMacAppBundle(source, destination);
      renameSync(source, join(root, "source-moved.app"));

      const copiedResource = join(destination, framework, "Resources/icudtl.dat");
      expect(readFileSync(copiedResource, "utf8")).toBe("fixture ICU data");
      expect(realpathSync(copiedResource)).toBe(
        realpathSync(join(destination, framework, "Versions/A/Resources/icudtl.dat")),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
