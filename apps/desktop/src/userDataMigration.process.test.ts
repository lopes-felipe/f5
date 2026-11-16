import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const exec = promisify(execFile);
it("two real processes import exactly once", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "f5-import-process-"));
  try {
    fs.mkdirSync(join(root, "legacy"));
    fs.writeFileSync(join(root, "legacy", "settings"), "value");
    const script = `import { migrateUserData } from ${JSON.stringify(new URL("./userDataMigration.ts", import.meta.url).href)};
      import * as fs from 'node:fs';
      const root = process.argv[1];
      const result = migrateUserData({ appDataBase: root, targetName: 'f5', legacyNames: ['legacy'], skipImport: false, platform: process.platform, hostname: 'test',
        copy: (...args) => { fs.appendFileSync(root + '/copies', 'copy\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); fs.cpSync(...args); } });
      console.log(JSON.stringify(result));`;
    const results = await Promise.all([
      exec(process.execPath, ["--input-type=module", "-e", script, root]),
      exec(process.execPath, ["--input-type=module", "-e", script, root]),
    ]);
    expect(results.map((r) => JSON.parse(r.stdout).kind)).toEqual(["ready", "ready"]);
    expect(fs.readFileSync(join(root, "copies"), "utf8")).toBe("copy\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
