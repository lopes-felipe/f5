import "../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ProjectId } from "@t3tools/contracts";
import {
  ProjectCreateNewController,
  openProjectCreateNewDialog,
} from "./ProjectCreateNewController";

const api = vi.hoisted(() => ({ projects: { createNew: vi.fn() } }));
const createThread = vi.hoisted(() => vi.fn(async () => ({})));
const toast = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("../nativeApi", () => ({ ensureNativeApi: () => api }));
vi.mock("../lib/projectArrival", () => ({ waitForProjectInStore: async () => {} }));
vi.mock("../hooks/useCreateProjectBackedDraftThread", () => ({
  useCreateProjectBackedDraftThread: () => createThread,
}));
vi.mock("./ui/toast", () => ({ toastManager: toast }));
afterEach(() => vi.clearAllMocks());

it("creates a project from a name and opens its first thread in the main checkout", async () => {
  const projectId = ProjectId.makeUnsafe("new-project");
  api.projects.createNew.mockResolvedValueOnce({
    projectId,
    workspaceRoot: "/home/me/f5-projects/my-app",
    warning: "The project was created, but its first commit failed: no identity",
  });
  openProjectCreateNewDialog();
  const screen = await render(<ProjectCreateNewController />);
  await screen.getByRole("textbox", { name: "Name" }).fill("  My App  ");
  await screen.getByRole("button", { name: "Create project" }).click();

  await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
  expect(api.projects.createNew).toHaveBeenCalledWith({ name: "My App" });
  await vi.waitFor(() =>
    expect(createThread).toHaveBeenCalledWith(projectId, {
      branch: null,
      worktreePath: null,
      envMode: "local",
    }),
  );
  expect(toast.add).toHaveBeenCalledWith(
    expect.objectContaining({ type: "warning", description: expect.stringContaining("commit") }),
  );
});

it("keeps the dialog open with the server's reason when creation fails", async () => {
  api.projects.createNew.mockRejectedValueOnce(new Error("Could not create the project: EACCES"));
  openProjectCreateNewDialog();
  const screen = await render(<ProjectCreateNewController />);
  await screen.getByRole("textbox", { name: "Name" }).fill("App");
  await screen.getByRole("button", { name: "Create project" }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("EACCES");
  expect(createThread).not.toHaveBeenCalled();
});
