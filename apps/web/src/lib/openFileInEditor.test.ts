import { beforeEach, expect, it, vi } from "vitest";
import { openFileInEditor } from "./openFileInEditor";

const mocks = vi.hoisted(() => ({
  api: { shell: { openInEditor: vi.fn() } },
  open: vi.fn(),
  read: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("../editorPreferences", () => ({ openInPreferredEditor: mocks.open }));
vi.mock("../nativeApi", () => ({ readNativeApi: mocks.read }));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.read.mockReturnValue(mocks.api);
});

it("preserves the full target and position when opening an editor", async () => {
  const target = "/tmp/report.json:4:2";
  await openFileInEditor(target);
  expect(mocks.open).toHaveBeenCalledWith(mocks.api, target);
  expect(mocks.toast).not.toHaveBeenCalled();
});

it("reports rejected editor handoffs with the file path", async () => {
  mocks.open.mockRejectedValue(new Error("Editor launch failed"));
  await expect(openFileInEditor("/tmp/report.json")).resolves.toBeUndefined();
  expect(mocks.toast).toHaveBeenCalledWith({
    type: "error",
    title: "Unable to open file",
    description: "/tmp/report.json: Editor launch failed",
  });
});

it("reports an unavailable native API", async () => {
  mocks.read.mockReturnValue(undefined);
  await openFileInEditor("/tmp/report.json");
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      description: "/tmp/report.json: Editor opening is unavailable.",
    }),
  );
});

it("uses VS Code explicitly when requested without choosing another preferred editor", async () => {
  await openFileInEditor("/tmp/report.json:4:2", "vscode");
  expect(mocks.api.shell.openInEditor).toHaveBeenCalledWith("/tmp/report.json:4:2", "vscode");
  expect(mocks.open).not.toHaveBeenCalled();
});

it("reports an explicit VS Code launch failure", async () => {
  mocks.api.shell.openInEditor.mockRejectedValue(new Error("VS Code not installed"));
  await openFileInEditor("/tmp/report.json", "vscode");
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      description: "/tmp/report.json: VS Code not installed",
    }),
  );
});
