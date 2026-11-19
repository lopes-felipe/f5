import { mkdtemp, writeFile, symlink, link, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { readHtmlSource } from "./readHtmlSource.ts";

it("snapshots HTML and rejects ambiguous, supervised, internal, linked and non-document sources", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "f5-html-source-"));
  try {
    const page = path.join(root, "page.html");
    await writeFile(page, "<!doctype html><h1>First</h1>");
    const snapshot = await readHtmlSource({ path: page }, "full-access", []);
    await writeFile(page, "<html>Second</html>");
    expect(snapshot).toContain("First");
    expect(await readHtmlSource({ html: "<p>inline</p>" }, "approval-required", [])).toContain(
      "inline",
    );
    for (const source of [
      {},
      { html: "inline", path: page },
      { path: "//server/page.html" },
      { path: "relative.html" },
    ])
      await expect(readHtmlSource(source, "full-access", [])).rejects.toThrow();
    await expect(readHtmlSource({ path: page }, "approval-required", [])).rejects.toThrow(
      "full-access",
    );
    await expect(readHtmlSource({ path: page }, "full-access", [root])).rejects.toThrow();
    const secret = path.join(root, "secret.txt");
    const alias = path.join(root, "alias.html");
    await writeFile(secret, "<html>secret</html>");
    await symlink(secret, alias);
    await expect(readHtmlSource({ path: alias }, "full-access", [])).rejects.toThrow();
    await writeFile(page, "not a document");
    await expect(readHtmlSource({ path: page }, "full-access", [])).rejects.toThrow();
    await writeFile(page, "<html>linked</html>");
    await link(page, path.join(root, "hard.html"));
    await expect(readHtmlSource({ path: page }, "full-access", [])).rejects.toThrow();
    const directory = path.join(root, "directory.html");
    await mkdir(directory);
    await expect(readHtmlSource({ path: directory }, "full-access", [])).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
