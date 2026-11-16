import { beforeEach, expect, it, vi } from "vitest";
import { resolveAndPersistPreferredEditor } from "./editorPreferences";

const storage = vi.hoisted(() => ({ stored: null as string | null, set: vi.fn() }));
vi.mock("./hooks/useLocalStorage", () => ({
  getLocalStorageItem: () => storage.stored,
  setLocalStorageItem: storage.set,
  useLocalStorage: vi.fn(),
}));

beforeEach(() => {
  storage.stored = null;
  storage.set.mockClear();
});

it("uses an available stored favorite without rewriting it", () => {
  storage.stored = "zed";
  expect(resolveAndPersistPreferredEditor(["vscode", "zed"])).toBe("zed");
  expect(storage.set).not.toHaveBeenCalled();
});

it("falls back without replacing a favorite that is currently unavailable", () => {
  storage.stored = "cursor";
  expect(resolveAndPersistPreferredEditor(["vscode", "file-manager"])).toBe("vscode");
  expect(storage.set).not.toHaveBeenCalled();
});

it("remembers the first available editor when there is no favorite yet", () => {
  expect(resolveAndPersistPreferredEditor(["zed", "vscode"])).toBe("vscode");
  expect(storage.set).toHaveBeenCalledWith("t3code:last-editor", "vscode", expect.anything());
});
