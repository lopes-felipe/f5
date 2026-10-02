import { it, expect, vi } from "vitest";
import { CaptureShortcut } from "./CaptureShortcut";
it("preserves a live shortcut on failed replacement and fences other renderer cleanup", () => {
  const registered = new Map<string, () => void>(),
    unregister = vi.fn((key: string) => registered.delete(key));
  const register = vi.fn((key: string, fn: () => void) => {
    if (key === "blocked") return false;
    registered.set(key, fn);
    return true;
  });
  const controls = new CaptureShortcut(register, unregister),
    first = vi.fn(),
    second = vi.fn();
  controls.configure(1, "first", true, first);
  expect(() => controls.configure(1, "blocked", true, first)).toThrow();
  registered.get("first")!();
  expect(first).toHaveBeenCalledOnce();
  expect(unregister).not.toHaveBeenCalled();
  controls.configure(2, "first", true, second);
  controls.release(1);
  registered.get("first")!();
  expect(second).toHaveBeenCalledOnce();
  controls.release(2);
  expect(unregister).toHaveBeenCalledWith("first");
});
