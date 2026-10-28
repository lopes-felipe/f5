import { expect, it } from "vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { resolveChatAssetTarget } from "./chatAssetTarget";
it.each([
  "//attacker/share/a.png",
  String.raw`\\attacker\share\a.png`,
  String.raw`/\attacker/share/a.png`,
  "%5C%5Cattacker%5Cshare%5Ca.png",
  "file://attacker/share/a.png",
])("does not authorize foreign network media: %s", (src) => {
  expect(
    resolveChatAssetTarget(src, "/repo", [{ id: ProjectId.make("root"), cwd: "/repo" }], []),
  ).toBeUndefined();
});
it("resolves relative and file URLs under the most specific root", () => {
  const projects = [
    { id: ProjectId.makeUnsafe("root"), cwd: "/repo" },
    { id: ProjectId.makeUnsafe("nested"), cwd: "/repo/app" },
  ];
  expect(resolveChatAssetTarget("images/a.png", "/repo/app", projects, [])).toEqual({
    identity: { kind: "project", projectId: "nested" },
    path: "images/a.png",
  });
  expect(resolveChatAssetTarget("file:///repo/app/images/a.png", "/repo", projects, [])?.path).toBe(
    "images/a.png",
  );
  expect(resolveChatAssetTarget("../../outside.png", "/repo/app", projects, [])).toBeUndefined();
  expect(
    resolveChatAssetTarget("file://remote/repo/file.png", "/repo", projects, []),
  ).toBeUndefined();
});
it("normalizes Windows drive paths and prefers worktree identities", () => {
  const threads = [{ id: ThreadId.makeUnsafe("thread"), worktreePath: "C:\\repo\\tree" }];
  expect(resolveChatAssetTarget("C:\\repo\\tree\\image.png", "C:\\repo", [], threads)).toEqual({
    identity: { kind: "thread", threadId: "thread" },
    path: "image.png",
  });
  expect(
    resolveChatAssetTarget("file:///C:/repo/tree/image.png", "C:\\repo", [], threads)?.path,
  ).toBe("image.png");
});

it("opens opaque saved attachment paths without granting arbitrary external files", () => {
  const name = "thread-12345678-1234-1234-1234-123456789abc.png";
  expect(resolveChatAssetTarget(`/profile/attachments/${name}`, "/repo", [], [])).toEqual({
    identity: { kind: "attachments" },
    path: name,
  });
  expect(
    resolveChatAssetTarget("/outside/attachments/private.png", "/repo", [], []),
  ).toBeUndefined();
});
