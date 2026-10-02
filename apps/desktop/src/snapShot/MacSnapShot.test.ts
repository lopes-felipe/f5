import { it, expect, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { captureMacWindow, accessibilityScript, activeWindowScript } from "./MacSnapShot";
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
