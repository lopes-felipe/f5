import { describe, expect, it } from "vitest";
import { publicUbuntuSources } from "./configure-browser-apt.ts";

describe("public Ubuntu browser dependency sources", () => {
  it("bypasses Azure mirror lists without changing suites or signature verification", () => {
    const source = [
      "Types: deb",
      "URIs: mirror+file:/etc/apt/apt-mirrors.txt",
      "Suites: noble noble-updates noble-backports noble-security",
      "Components: main restricted universe multiverse",
      "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg",
      "",
    ].join("\n");
    expect(publicUbuntuSources(source)).toBe(
      source.replace("mirror+file:/etc/apt/apt-mirrors.txt", "https://archive.ubuntu.com/ubuntu/"),
    );
  });

  it.each(["http", "https"])("handles direct %s Azure sources in legacy source lists", (scheme) => {
    const options = "[arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg]";
    const source = `deb ${options} ${scheme}://azure.archive.ubuntu.com/ubuntu/ noble main\n`;
    expect(publicUbuntuSources(source)).toBe(
      `deb ${options} https://archive.ubuntu.com/ubuntu/ noble main\n`,
    );
  });

  it("preserves unrelated repositories, public security sources, and comments", () => {
    const source = [
      "# mirror+file:/etc/apt/apt-mirrors.txt",
      "deb https://security.ubuntu.com/ubuntu/ noble-security main",
      "deb https://packages.microsoft.com/repos/code stable main",
      "URIs: mirror+file:/etc/apt/apt-mirrors.txt.other",
      "URIs: https://azure.archive.ubuntu.com/ubuntu/not-a-root",
      "",
    ].join("\n");
    expect(publicUbuntuSources(source)).toBe(source);
  });

  it("is idempotent", () => {
    const once = publicUbuntuSources("URIs: mirror+file:/etc/apt/apt-mirrors.txt\n");
    expect(publicUbuntuSources(once)).toBe(once);
  });
});
