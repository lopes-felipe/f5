import * as FS from "node:fs/promises";
import * as Path from "node:path";
import * as OS from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { ServerConfigShape } from "../config";
import { runProcess } from "../processRunner";
import { fallbackDefaultProfile } from "../profiles/ProfileRegistryStore";
import { profileGitEnvironment } from "./profileGitEnvironment";

describe("profile Git identity", () => {
  it("uses each profile's author and host-bound saved credentials in real Git", async () => {
    const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-git-account-"));
    try {
      await runProcess("git", ["init", root], { env: process.env });
      await runProcess(
        "git",
        ["config", "credential.https://github.com.helper", "!echo password=ambient-account"],
        { cwd: root, env: process.env },
      );
      await runProcess(
        "git",
        ["config", "http.https://github.com.extraHeader", "Authorization: ambient-account"],
        { cwd: root, env: process.env },
      );
      for (const name of ["Work", "Personal"]) {
        const stateDir = Path.join(root, name);
        await FS.mkdir(stateDir);
        const config = {
          stateDir,
          profile: { ...fallbackDefaultProfile(stateDir), isDefault: false },
        } as unknown as ServerConfigShape;
        const input = {
          config,
          cwd: root,
          args: ["commit", "--allow-empty", "-m", name],
          authorName: name,
          authorEmail: `${name.toLowerCase()}@example.com`,
          tokenForHost: async (host: string) => (host === "github.com" ? `token-${name}` : null),
        };
        const env = await profileGitEnvironment(input);
        await runProcess("git", input.args, { cwd: root, env });
        expect(
          (
            await runProcess("git", ["log", "-1", "--format=%an <%ae>"], { cwd: root, env })
          ).stdout.trim(),
        ).toBe(`${name} <${input.authorEmail}>`);
        const credentials = await profileGitEnvironment({
          ...input,
          args: ["fetch", "https://github.com/org/repo.git"],
        });
        const result = await runProcess("git", ["credential", "fill"], {
          cwd: root,
          env: credentials,
          stdin: "protocol=https\nhost=github.com\n\n",
        });
        expect(result.stdout).toContain(`password=token-${name}`);
        expect(result.stdout).not.toContain("ambient-account");
        const headers = await runProcess(
          "git",
          ["config", "--get-all", "http.https://github.com.extraHeader"],
          { cwd: root, env: credentials },
        );
        expect(headers.stdout.split(/\r?\n/).slice(-2)).toEqual(["", ""]);
        const rejected = await runProcess("git", ["credential", "fill"], {
          cwd: root,
          env: credentials,
          stdin: "protocol=https\nhost=unrelated.example\n\n",
          allowNonZeroExit: true,
        });
        expect(rejected.stdout).not.toContain(`token-${name}`);
      }
    } finally {
      await FS.rm(root, { recursive: true, force: true });
    }
  });
  it("rejects SSH and embedded remote credentials before requesting a token", async () => {
    const tokenForHost = vi.fn(async () => "saved");
    const stateDir = Path.resolve("profile-test");
    for (const remote of [
      "git@github.com:org/repo.git",
      "https://user:password@github.com/org/repo.git",
    ]) {
      await expect(
        profileGitEnvironment({
          config: { stateDir } as unknown as ServerConfigShape,
          cwd: stateDir,
          args: ["fetch", remote],
          authorName: "",
          authorEmail: "",
          tokenForHost,
        }),
      ).rejects.toThrow(/HTTPS|embedded/);
    }
    expect(tokenForHost).not.toHaveBeenCalled();
  });
});
