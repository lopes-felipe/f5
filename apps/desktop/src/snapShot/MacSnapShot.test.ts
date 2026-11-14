import { it, expect, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import {
  captureMacWindow,
  accessibilityScript,
  activeWindowScript,
  selectMacContentWindow,
} from "./MacSnapShot";

it("skips transparent windows and untitled helper strips without preferring the largest window", () => {
  const window = (id: number, title: string, width: number, height: number, alpha = 1) => ({
    id,
    kCGWindowName: title,
    kCGWindowOwnerPID: 42,
    kCGWindowAlpha: alpha,
    kCGWindowBounds: { X: 0, Y: 0, Width: width, Height: height },
  });
  const content = window(3, "content", 800, 600);
  const helper = window(2, "", 800, 20);
  const transparent = window(1, "transparent", 800, 600, 0);
  expect(
    selectMacContentWindow([transparent, helper, content, window(4, "large", 1600, 1200)]),
  ).toBe(content);
  expect(selectMacContentWindow([window(1, "", 20, 600), content])).toBe(content);
  expect(selectMacContentWindow([window(1, "named strip", 800, 20), content])?.id).toBe(1);
  expect(selectMacContentWindow([window(1, "", 800, 20)])?.id).toBe(1);
  expect(selectMacContentWindow([transparent])).toBeUndefined();
});

it("runs content selection inside the generated JXA lookup and excludes F5", () => {
  const window = (id: number, pid: number, height: number) => ({
    kCGWindowNumber: id,
    kCGWindowOwnerPID: pid,
    kCGWindowLayer: 0,
    kCGWindowAlpha: 1,
    kCGWindowBounds: { X: 0, Y: 0, Width: 800, Height: height },
  });
  const result = runInNewContext(activeWindowScript(777), {
    ObjC: { import: () => {}, deepUnwrap: (value: unknown) => value },
    $: {
      CGWindowListCopyWindowInfo: () => [
        window(1, 777, 600),
        window(2, 42, 20),
        window(3, 42, 600),
      ],
    },
  });
  expect(JSON.parse(result)).toMatchObject({ id: 3, pid: 42 });
});
it("bounds window capture and accessibility text, then focuses the owning window", async () => {
  const image = {
    getSize: () => ({ width: 3000, height: 2000 }),
    resize: vi.fn(() => ({
      getSize: () => ({ width: 2560, height: 1707 }),
      resize: vi.fn(),
      toPNG: () => Buffer.from("png"),
    })),
    toPNG: () => Buffer.from("png"),
  };
  const focus = vi.fn();
  const execute = vi.fn(async (file: string, args: string[], timeout: number) => {
    if (file.endsWith("screencapture")) {
      await writeFile(args.at(-1)!, "synthetic");
      return "";
    }
    if (args.at(-1)!.includes("CGWindow"))
      return JSON.stringify({ id: 123, pid: 456, title: "Fixture", app: "Synthetic" });
    expect(timeout).toBe(3000);
    return "x".repeat(30000);
  });
  const result = await captureMacWindow({ pid: 777, image: () => image as never, focus, execute });
  expect(image.resize).toHaveBeenCalledWith({ width: 2560 });
  expect(result.context.bytes.length).toBeLessThanOrEqual(20003);
  expect(focus).toHaveBeenCalledOnce();
  expect(activeWindowScript(777)).toContain("!==777");
  expect(accessibilityScript(456)).toContain("2000");
});
it("recovers from inaccessible accessibility text without dropping the image", async () => {
  const execute = async (file: string, args: string[]) => {
    if (file.endsWith("screencapture")) {
      await writeFile(args.at(-1)!, "png");
      return "";
    }
    if (args.at(-1)!.includes("CGWindow")) return JSON.stringify({ id: 1, pid: 2 });
    throw new Error("permission");
  };
  const result = await captureMacWindow({
    pid: 3,
    image: () => ({
      getSize: () => ({ width: 100, height: 100 }),
      resize: vi.fn(),
      toPNG: () => Buffer.from("png"),
    }),
    focus: vi.fn(),
    execute,
  });
  expect(new TextDecoder().decode(result.context.bytes)).toContain(
    "Accessibility text unavailable",
  );
});

it("only walks the uniquely matching captured window, omitting ambiguous matches", async () => {
  const { runInNewContext } = await import("node:vm");
  const window = (name: string, x: number) => ({
    position: () => [x, 0],
    size: () => [100, 100],
    role: () => "window",
    name: () => name,
    uiElements: () => [],
  });
  const script = accessibilityScript(2, { X: 0, Y: 0, Width: 100, Height: 100 });
  const run = (windows: unknown[]) =>
    runInNewContext(script, {
      Application: () => ({ processes: { whose: () => () => [{ windows: () => windows }] } }),
    });
  expect(run([window("captured", 0), window("private background", 100)])).toContain("captured");
  expect(run([window("captured", 0), window("private background", 100)])).not.toContain(
    "private background",
  );
  expect(run([window("one", 0), window("two", 0)])).toBe("");
});
