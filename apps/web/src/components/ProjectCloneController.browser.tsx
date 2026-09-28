import "../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ProjectId, type ProjectCloneJob } from "@t3tools/contracts";
import { ProjectCloneController, openProjectCloneDialog } from "./ProjectCloneController";

const api = vi.hoisted(() => ({
  projects: { clone: vi.fn(), cloneList: vi.fn(async () => []), cloneCancel: vi.fn() },
  dialogs: { pickFolder: vi.fn() },
}));
vi.mock("../nativeApi", () => ({ ensureNativeApi: () => api }));
vi.mock("../hooks/useCreateProjectBackedDraftThread", () => ({
  useCreateProjectBackedDraftThread: () => vi.fn(),
}));
vi.mock("./ui/toast", () => ({ toastManager: { add: vi.fn(), update: vi.fn() } }));
afterEach(() => vi.clearAllMocks());
it("keeps clone submission visible until admitted, then closes while the server continues", async () => {
  let admit!: (job: ProjectCloneJob) => void;
  api.projects.clone.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        admit = resolve;
      }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  openProjectCloneDialog("/projects");
  const screen = await render(
    <QueryClientProvider client={client}>
      <ProjectCloneController />
    </QueryClientProvider>,
  );
  await screen
    .getByRole("textbox", { name: "Repository URL or owner/repository" })
    .fill("owner/example");
  await expect
    .element(screen.getByRole("textbox", { name: "New folder name" }))
    .toHaveValue("example");
  await screen.getByRole("button", { name: "Clone in background" }).click();
  await expect.element(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();
  const request = api.projects.clone.mock.calls[0]![0];
  expect(request.parentPath).toBe("/projects");
  admit({
    ...request,
    projectId: ProjectId.makeUnsafe(request.operationId),
    destination: "/projects/example",
    status: "queued",
    progress: "Waiting to clone",
    error: null,
    createdAt: new Date().toISOString(),
  });
  await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
  expect(client.getQueryData<readonly ProjectCloneJob[]>(["project-clones"])?.[0]?.status).toBe(
    "queued",
  );
  client.clear();
});
