import { mkdtemp, mkdir, rm, stat, realpath, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConnection } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import {
  desktopAppControlAddress,
  openInDesktopApp,
  startDesktopAppControl,
} from "./desktopAppControl";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
it("uses the same address across temp environments and state-directory aliases", async () => {
  const { root } = await fixture();
  const original = desktopAppControlAddress(root);
  expect(desktopAppControlAddress("~/")).toEqual(desktopAppControlAddress(os.homedir()));
  vi.stubEnv("TMPDIR", "/different/shell/temp");
  vi.stubEnv("TMP", "/different/shell/temp");
  vi.stubEnv("TEMP", "/different/shell/temp");
  expect(desktopAppControlAddress(path.relative(process.cwd(), root))).toEqual(original);
  const alias = path.join(root, "alias");
  await symlink(root, alias, "junction");
  expect(desktopAppControlAddress(alias)).toEqual(original);
});
it("preserves request IDs when the project disappears before server validation", async () => {
  const { root } = await fixture();
  cleanups.push(await startDesktopAppControl(root, async () => {}));
  const socket = createConnection(desktopAppControlAddress(root).address);
  try {
    const reply = new Promise<string>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("data", (data) => resolve(data.toString()));
    });
    socket.write(
      JSON.stringify({ id: "missing-project", path: path.join(root, "missing") }) + "\n",
    );
    expect(JSON.parse(await reply)).toMatchObject({
      id: "missing-project",
      ok: false,
      error: expect.stringContaining("ENOENT"),
    });
  } finally {
    socket.destroy();
  }
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "f5-app-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  await mkdir(project);
  return { root, project };
}
it("opens a real directory only after the running app acknowledges it", async () => {
  const { root, project } = await fixture();
  const activate = vi.fn(async () => {});
  const stop = await startDesktopAppControl(root, activate);
  cleanups.push(stop);
  await openInDesktopApp(root, project, {});
  expect(activate).toHaveBeenCalledWith({ id: expect.any(String), path: await realpath(project) });
  if (process.platform !== "win32") {
    expect((await stat(desktopAppControlAddress(root).address)).mode & 0o777).toBe(0o600);
  }
});
it("reports renderer failures and refuses SSH without contacting the app", async () => {
  const { root, project } = await fixture();
  const activate = vi.fn(async () => {
    throw new Error("Cannot create thread");
  });
  cleanups.push(await startDesktopAppControl(root, activate));
  await expect(openInDesktopApp(root, project, {})).rejects.toThrow("Cannot create thread");
  await expect(openInDesktopApp(root, project, { SSH_TTY: "test" })).rejects.toThrow("over SSH");
  expect(activate).toHaveBeenCalledTimes(1);
});
it("reports an absent desktop without starting a server", async () => {
  const { root, project } = await fixture();
  await expect(openInDesktopApp(root, project, {})).rejects.toThrow("No F5 desktop app");
});
it("survives a client disconnecting before the activation acknowledgement", async () => {
  const { root, project } = await fixture();
  let complete!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let calls = 0;
  cleanups.push(
    await startDesktopAppControl(root, async () => {
      if (++calls === 1) {
        started();
        await gate;
      }
    }),
  );
  const client = createConnection(desktopAppControlAddress(root).address);
  client.on("error", () => {});
  await new Promise<void>((resolve) => client.once("connect", resolve));
  client.write(JSON.stringify({ id: "disconnect-test", path: await realpath(project) }) + "\n");
  await ready;
  client.destroy();
  complete();
  await openInDesktopApp(root, project, {});
  expect(calls).toBe(2);
});
