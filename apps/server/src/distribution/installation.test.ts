import { describe, expect, it } from "vitest";
import { validateArchiveListing } from "./installation";
import { serviceDefinition } from "./services";
describe("runtime installation boundaries", () => {
  it("rejects tar traversal, absolute paths, symlinks and hard links", () => {
    expect(() =>
      validateArchiveListing(
        "f5/\nf5/client/index.html\n",
        "drwxr-xr-x 0 user group 0 Oct 2 f5/\n-rw-r--r-- 0 user group 100 Oct 2 f5/client/index.html\n",
        "f5",
      ),
    ).not.toThrow();
    for (const file of [
      "../database",
      "/etc/passwd",
      "f5/../database",
      "f5\\..\\database",
      "elsewhere/file",
    ])
      expect(() => validateArchiveListing(file + "\n", "-rw file\n", "f5")).toThrow();
    for (const type of ["l", "h", "b", "c"])
      expect(() => validateArchiveListing("f5/file\n", type + "rw file\n", "f5")).toThrow();
  });
  it("quotes service arguments and explicitly rejects Windows services", () => {
    expect(
      serviceDefinition("linux", ["/a space/node", "/f5/launcher.cjs", "%home/$value"]).contents,
    ).toContain('"/a space/node"');
    expect(serviceDefinition("linux", ["%home/$value"]).contents).toContain("%%home/$$value");
    expect(serviceDefinition("darwin", ["/a&b/node"]).contents).toContain("/a&amp;b/node");
    expect(() => serviceDefinition("linux", ["bad\npath"])).toThrow();
    expect(() => serviceDefinition("win32", ["f5"])).toThrow("foreground");
  });
});
