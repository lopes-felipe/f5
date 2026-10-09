import { describe, expect, it } from "vitest";
import { checkoutConflictFiles } from "./checkoutConflict";

describe("checkoutConflictFiles", () => {
  it("collects tracked and untracked conflicts, including Git-quoted filenames", () => {
    expect(
      checkoutConflictFiles(
        [
          "git checkout main -- failed: error: Your local changes to the following files would be overwritten by checkout:",
          "\tapps/web/src/index.css",
          '\t"caf\\303\\251.txt"',
          "Please commit your changes or stash them before you switch branches.",
          "error: The following untracked working tree files would be overwritten by checkout:",
          "\tnew file.txt",
          "\tapps/web/src/index.css",
          "Please move or remove them before you switch branches.",
          "Aborting",
        ].join("\n"),
      ),
    ).toEqual(["apps/web/src/index.css", "café.txt", "new file.txt"]);
  });

  it("preserves leading and trailing spaces and literal backslashes in unquoted paths", () => {
    expect(
      checkoutConflictFiles(
        "error: Your local changes to the following files would be overwritten by checkout:\r\n\t leading\\name \r\nAborting",
      ),
    ).toEqual([" leading\\name "]);
  });

  it.each([
    "fatal: invalid reference: missing",
    "fatal: 'main' is already checked out at '/repo'",
    "error: you need to resolve your current index first",
  ])("keeps other errors unclassified: %s", (detail) => {
    expect(checkoutConflictFiles(detail)).toBeNull();
  });
});
