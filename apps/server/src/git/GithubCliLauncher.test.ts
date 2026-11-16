import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { javascriptRuntimeExecutable } from "@t3tools/shared/hostRuntime";
import { expect, it } from "vitest";
import { prepareGithubLauncher, resolveProfileGithubLauncher } from "./GithubCliLauncher";

it("recognizes only the selected profile's unchanged generated Windows launcher", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "f5-gh-launcher-"));
  try {
    const personal = path.join(root, "personal");
    const work = path.join(root, "work");
    await prepareGithubLauncher(personal);
    await prepareGithubLauncher(work);
    const wrapper = path.join(work, "github-bin", "gh.cmd");
    const env = { GH_CONFIG_DIR: path.join(work, "github") };
    expect(resolveProfileGithubLauncher(wrapper, env)).toEqual({
      runtime: javascriptRuntimeExecutable(),
      script: path.join(work, "github-bin", "gh.cjs"),
    });
    expect(
      resolveProfileGithubLauncher(path.join(personal, "github-bin", "gh.cmd"), env),
    ).toBeNull();
    expect(resolveProfileGithubLauncher(wrapper, {})).toBeNull();
    await fs.appendFile(wrapper, "echo changed\r\n");
    expect(() => resolveProfileGithubLauncher(wrapper, env)).toThrow("changed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
