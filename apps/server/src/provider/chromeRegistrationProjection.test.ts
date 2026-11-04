import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROVIDER_INTEGRATION_RECORDS } from "@t3tools/shared/providerIntegrationCertification";
import { claudeChromeDescriptor } from "./chromeNativeHost";
import {
  ChromeProjectionFailed,
  projectClaudeRegistrations,
  projectionIo,
  type ClaudeRegistrationProjection,
} from "./chromeRegistrationProjection";

const record = PROVIDER_INTEGRATION_RECORDS["claude-chrome"].find((entry) => !entry.withdrawn)!;
const descriptor = claudeChromeDescriptor(record);

let root: string;
let exe: string;
let cliHome: string;
let chromeHome: string;
let providerHome: string;
let wrapperPath: string;
let projection: ClaudeRegistrationProjection;
const paths = (locations: ClaudeRegistrationProjection["sources"]) =>
  locations.map((location) => (location.kind === "file" ? location.path : ""));

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "f5-chrome-projection-")));
  exe = join(root, "claude");
  await writeFile(exe, "binary");
  cliHome = join(root, "state", "provider-homes", "claude");
  chromeHome = join(root, "home");
  providerHome = join(cliHome, ".claude");
  wrapperPath = descriptor.expectedTarget(providerHome);
  projection = {
    sources: descriptor.locations(providerHome, cliHome),
    destinations: descriptor.locations(providerHome, chromeHome),
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const manifest = (path = wrapperPath, origins = record.identity.allowedOrigins) =>
  `${JSON.stringify(
    {
      name: record.identity.hostName,
      description: "x",
      path,
      type: "stdio",
      allowed_origins: origins,
    },
    null,
    2,
  )}\n`;
/** What the CLI writes under the isolated HOME. */
async function cliWrites(bytes = manifest(), wrapper = true) {
  if (wrapper) {
    await mkdir(dirname(wrapperPath), { recursive: true });
    await writeFile(
      wrapperPath,
      `${record.identity.wrapperHeader.join("\n")}\nexec ${exe} --chrome-native-host\n`,
      { mode: 0o755 },
    );
  }
  for (const path of paths(projection.sources)) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
}
const project = (overrides: Partial<Parameters<typeof projectClaudeRegistrations>[0]> = {}) =>
  projectClaudeRegistrations({
    projection,
    targetPath: wrapperPath,
    allowedOrigins: record.identity.allowedOrigins,
    verifyWrapper: (bytes) => descriptor.verifyWrapper!(bytes, exe, (path) => realpath(path)),
    timeoutMs: 100,
    intervalMs: 10,
    ...overrides,
  });
const destinationsWritten = async () =>
  (
    await Promise.all(
      paths(projection.destinations).map((path) => readFile(path, "utf8").catch(() => null)),
    )
  ).filter((bytes) => bytes !== null);

describe.skipIf(process.platform === "win32")("Claude in Chrome registration projection", () => {
  it("copies every manifest byte for byte to Chrome's home, leaving no temp files", async () => {
    await cliWrites();
    const written = await project();
    expect(written).toEqual(paths(projection.destinations));
    expect(written).toHaveLength(record.browsers.length);
    for (const [index, path] of paths(projection.destinations).entries())
      expect(await readFile(path, "utf8")).toBe(
        await readFile(paths(projection.sources)[index]!, "utf8"),
      );
    for (const path of paths(projection.destinations))
      expect((await readdir(dirname(path))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    // Unchanged destinations are not rewritten.
    expect(await project()).toEqual([]);
  });

  it("waits for the CLI to finish writing", async () => {
    const pending = project({ timeoutMs: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await cliWrites();
    expect(await pending).toHaveLength(record.browsers.length);
  });

  it.each([
    ["missing", async () => {}],
    ["malformed", () => cliWrites("{not json")],
    ["aimed at another wrapper", () => cliWrites(manifest("/Applications/Other.app/host"))],
    [
      "allowing an uncertified origin",
      () => cliWrites(manifest(wrapperPath, ["chrome-extension://evil/"])),
    ],
    ["missing its wrapper", () => cliWrites(manifest(), false)],
  ])("writes nothing when the registration is %s", async (_name, arrange) => {
    await arrange();
    await expect(project()).rejects.toBeInstanceOf(ChromeProjectionFailed);
    expect(await destinationsWritten()).toEqual([]);
  });

  it("refuses a wrapper that execs anything but the bundled Claude", async () => {
    await cliWrites();
    await writeFile(wrapperPath, "#!/bin/sh\nexec /tmp/evil --chrome-native-host\n");
    await expect(project()).rejects.toThrow("wrapper");
    expect(await destinationsWritten()).toEqual([]);
  });

  it("replaces a destination atomically, never through a partial file", async () => {
    await cliWrites();
    const [first] = paths(projection.destinations);
    await mkdir(dirname(first!), { recursive: true });
    await writeFile(first!, manifest("/old"));
    await projectionIo.writeAtomic(first!, manifest());
    expect(await readFile(first!, "utf8")).toBe(manifest());
  });
});
