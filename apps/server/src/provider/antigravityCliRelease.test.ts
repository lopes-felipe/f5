import { expect, it } from "vitest";
import { parseAntigravityCliRelease } from "./antigravityCliRelease";

it("accepts only versioned binaries in Google's Antigravity CLI bucket", () => {
  const url =
    "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-123/linux-x64/cli_linux_x64.tar.gz";
  const manifest = { version: "1.5.14", sha512: "a".repeat(128), url };
  expect(parseAntigravityCliRelease(manifest, "linux", "x64")).not.toBeNull();
  for (const bad of [
    url.replace("storage.googleapis.com", "example.com"),
    url.replace("antigravity-public", "other-bucket"),
    url.replace("antigravity-cli", "other-channel"),
    url + "?redirect=elsewhere",
    url.replace("https:", "http:"),
    url.replace("/linux-x64/", "/../linux-x64/"),
  ])
    expect(parseAntigravityCliRelease({ ...manifest, url: bad }, "linux", "x64")).toBeNull();
});
