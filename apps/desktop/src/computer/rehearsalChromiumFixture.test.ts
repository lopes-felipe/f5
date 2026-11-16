import { readFile, mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import {
  CHROMIUM_FIXTURE_BUNDLE,
  decodeChromiumFixture,
  readChromiumFixture,
} from "./rehearsalChromiumFixture";

const appId = "org.example.chromium-computer-fixture.4d01a26c-372f-40dd-8b7b-47ec17b07056";
const metadata = { version: 1, bundle: CHROMIUM_FIXTURE_BUNDLE, appId };
const roots: string[] = [];
it("pins the Windows fixture executable and rejects traversal or arbitrary app names", () => {
  const windows = {
    version: 1,
    platform: "win32",
    appId: "f5-chromium-fixture.exe",
    bundle: "ChromiumFixture",
  };
  expect(decodeChromiumFixture(windows)).toEqual({
    appId: "f5-chromium-fixture.exe",
    platform: "win32",
  });
  for (const patch of [
    { appId: "electron.exe" },
    { appId: "../f5.exe" },
    { bundle: "../UserApp" },
  ]) {
    expect(() => decodeChromiumFixture({ ...windows, ...patch })).toThrow(
      "Invalid Chromium fixture metadata",
    );
  }
});
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it.each([
  null,
  { ...metadata, appId: "com.github.Electron" },
  { ...metadata, bundle: "../User.app" },
  { ...metadata, version: 2 },
])("rejects other app identities and unsupported metadata", (value) => {
  expect(() => decodeChromiumFixture(value)).toThrow("Invalid Chromium fixture metadata");
});
it("reads only the suite fixture and rejects bundle links outside preparation", async () => {
  const root = await mkdtemp(join(tmpdir(), "f5-chromium-fixture-test-"));
  roots.push(root);
  const prepared = join(root, "prepared");
  await mkdir(prepared);
  await writeFile(join(prepared, "electron-fixture.json"), JSON.stringify(metadata));
  await mkdir(join(root, "outside"));
  await symlink(
    join(root, "outside"),
    join(prepared, CHROMIUM_FIXTURE_BUNDLE),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(readChromiumFixture(prepared)).rejects.toThrow("escaped preparation directory");
});

it("produces only trusted synthetic DOM receipts and never sends typed or secure values", async () => {
  const callbacks = new Map<string, (event: { isTrusted: boolean }) => void>();
  const send = vi.fn();
  const fields = Object.fromEntries(
    ["input", "secure", "press", "counter", "focus-secure"].map((id) => [
      id,
      {
        value: "PRIVATE_SENTINEL",
        textContent: "",
        focus: vi.fn(),
        addEventListener: (name: string, callback: (event: { isTrusted: boolean }) => void) =>
          callbacks.set(id + "." + name, callback),
      },
    ]),
  );
  let ready: (() => void) | undefined;
  const source = await readFile(
    resolve(import.meta.dirname, "../../native/electron/preload.cjs"),
    "utf8",
  );
  runInNewContext(source, {
    require: (name: string) => {
      if (name !== "electron") throw new Error("Unexpected fixture dependency");
      return { ipcRenderer: { send } };
    },
    document: { getElementById: (id: string) => fields[id] },
    window: {
      addEventListener: (_name: string, callback: () => void) => {
        ready = callback;
      },
    },
  });
  ready!();
  callbacks.get("press.click")!({ isTrusted: false });
  fields.input!.value = "F5_ELECTRON_REHEARSAL Ω🙂";
  callbacks.get("input.input")!({ isTrusted: false });
  expect(send.mock.calls).toEqual([["fixture-observation", "ready"]]);
  callbacks.get("press.click")!({ isTrusted: true });
  callbacks.get("input.input")!({ isTrusted: true });
  fields.input!.value = "PRIVATE_SENTINEL";
  callbacks.get("input.input")!({ isTrusted: true });
  expect(send.mock.calls).toEqual([
    ["fixture-observation", "ready"],
    ["fixture-observation", "press"],
    ["fixture-observation", "typed"],
  ]);
  expect(JSON.stringify(send.mock.calls)).not.toContain("PRIVATE_SENTINEL");
  expect(fields.secure!.focus).not.toHaveBeenCalled();
});
