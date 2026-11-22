import { describe, expect, it } from "vitest";
import { changeRequestsCreatedBy as detect } from "./createdChangeRequests";
import { parseSourceControlPullRequestUrl } from "./sourceControl";

const changeRequestsCreatedBy = (input: string, output: string) =>
  detect(input, output, parseSourceControlPullRequestUrl);

describe("created change requests", () => {
  const url = "https://github.com/o/r/pull/12";
  it.each(["gh pr create --fill", "timeout 60 gh pr create", "/bin/zsh -lc 'gh pr create --fill'"])(
    "recognizes executed create commands: %s",
    (command) => {
      expect(changeRequestsCreatedBy(command, url)).toMatchObject([
        { provider: "github", number: 12 },
      ]);
    },
  );
  it.each([
    "echo 'gh pr create'",
    "echo gh pr create",
    "# gh pr create",
    "gh pr create#x",
    "gh pr create; gh pr list",
    "gh pr create; gh pr view 12",
    "cat <<'EOF'\ngh pr create\nEOF",
  ])("ignores text and ambiguous output: %s", (command) => {
    expect(changeRequestsCreatedBy(command, url)).toEqual([]);
  });
  it("requires a URL on its own line and the matching forge", () => {
    expect(changeRequestsCreatedBy("gh pr create", "Opened " + url)).toEqual([]);
    expect(changeRequestsCreatedBy("gh pr create", url + "/files")).toEqual([]);
    expect(
      changeRequestsCreatedBy("gh pr create", url + "\nhttps://github.com/o/r/pull/13"),
    ).toEqual([]);
    expect(changeRequestsCreatedBy("glab mr create", url)).toEqual([]);
    expect(
      changeRequestsCreatedBy("glab mr create", "https://gitlab.com/o/r/-/merge_requests/4"),
    ).toMatchObject([{ provider: "gitlab", number: 4 }]);
    expect(
      changeRequestsCreatedBy(
        "glab mr create",
        "https://git.example.com/group/r/-/merge_requests/4",
      ),
    ).toMatchObject([{ provider: "gitlab", host: "git.example.com", number: 4 }]);
  });
});
