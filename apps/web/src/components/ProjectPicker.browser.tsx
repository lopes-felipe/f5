import "../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { ProjectId } from "@t3tools/contracts";
import type { Project } from "../types";
import { ProjectPicker } from "./ProjectPicker";
import { ProjectArchiveButton } from "./ProjectPinButton";

const api = vi.hoisted(() => ({ orchestration: { dispatchCommand: vi.fn(async () => ({})) } }));
vi.mock("../nativeApi", () => ({ ensureNativeApi: () => api }));
afterEach(() => {
  vi.clearAllMocks();
});
const project = (name: string, patch: Partial<Project> = {}): Project => ({
  id: ProjectId.makeUnsafe(name),
  name,
  cwd: "/" + name,
  model: "gpt-5",
  createdAt: "2026-11-20T00:00:00Z",
  expanded: true,
  scripts: [],
  memories: [],
  icon: { type: "lucide", glyph: "folder", color: "gray" },
  ...patch,
});

it("orders favorites first, hides archives and pins without selecting a project", async () => {
  const onSelect = vi.fn();
  const screen = await render(
    <ProjectPicker
      projects={[
        project("Alpha"),
        project("Favorite", { pinned: true }),
        project("Hidden", { archived: true }),
      ]}
      selection={null}
      allowNone={false}
      trigger="home"
      onSelect={onSelect}
    />,
  );
  await screen.getByRole("combobox", { name: "Project", exact: true }).click();
  await vi.waitFor(() => {
    expect(
      [...document.querySelectorAll('[role="option"]')].map((row) => row.textContent?.trim()),
    ).toEqual(["Favorite", "Alpha"]);
  });
  await page.getByRole("button", { name: "Pin Alpha", exact: true }).click();
  await vi.waitFor(() =>
    expect(api.orchestration.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "project.meta.update", projectId: "Alpha", pinned: true }),
    ),
  );
  expect(onSelect).not.toHaveBeenCalled();
  await page.getByText("Favorite", { exact: true }).click();
  await vi.waitFor(() =>
    expect(onSelect).toHaveBeenCalledWith({ kind: "project", projectId: "Favorite" }),
  );
  await screen.unmount();
});

it("archives and restores projects through the shared server mutation", async () => {
  const screen = await render(<ProjectArchiveButton project={project("Alpha")} />);
  await screen.getByRole("button", { name: "Archive project Alpha" }).click();
  await vi.waitFor(() =>
    expect(api.orchestration.dispatchCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectId: "Alpha", archived: true }),
    ),
  );
  await screen.rerender(<ProjectArchiveButton project={project("Alpha", { archived: true })} />);
  await screen.getByRole("button", { name: "Restore project Alpha" }).click();
  await vi.waitFor(() =>
    expect(api.orchestration.dispatchCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectId: "Alpha", archived: false }),
    ),
  );
  await screen.unmount();
});
