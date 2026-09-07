import { expect, it } from "vitest";
import { parseRemoteFetchUrls } from "./remoteInspection.ts";
it("parses fetch remotes including local paths with spaces", () => {
  expect([
    ...parseRemoteFetchUrls(
      "origin\tgit@github.com:org/repo.git (fetch)\r\norigin\tignored (push)\nlocal\tC:/my repos/clone (fetch)\n",
    ),
  ]).toEqual([
    ["origin", "git@github.com:org/repo.git"],
    ["local", "C:/my repos/clone"],
  ]);
});
