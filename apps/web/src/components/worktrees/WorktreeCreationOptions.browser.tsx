import "../../index.css";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { useComposerDraftStore } from "../../composerDraftStore";
import { WorktreeCreationOptions } from "./WorktreeCreationOptions";

const threadId = ThreadId.makeUnsafe("options");
let screen: Awaited<ReturnType<typeof render>> | undefined;
beforeEach(() => {
  useComposerDraftStore.setState({
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
  });
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(ProjectId.makeUnsafe("project"), threadId, { envMode: "worktree" });
});
afterEach(async () => {
  await screen?.unmount();
});
it("saves and clears explicit names, rejects whitespace, and persists setup opt-out", async () => {
  screen = await render(
    <WorktreeCreationOptions threadId={threadId} multiModel={false} hasSetupScript />,
  );
  await page.getByRole("checkbox", { name: "Run setup script" }).click();
  expect(useComposerDraftStore.getState().getDraftThread(threadId)?.runSetupScript).toBe(false);
  await page.getByRole("button", { name: "Branch: auto" }).click();
  await page.getByRole("textbox", { name: "Branch name" }).fill("bad name");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("without whitespace");
  await page.getByRole("textbox", { name: "Branch name" }).fill("feature/named");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "Branch: feature/named" })).toBeVisible();
  expect(useComposerDraftStore.getState().getDraftThread(threadId)?.worktreeBranchName).toBe(
    "feature/named",
  );
  await page.getByRole("button", { name: "Branch: feature/named" }).click();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  expect(useComposerDraftStore.getState().getDraftThread(threadId)?.worktreeBranchName).toBeNull();
});
it("disables explicit names for fan-out, retains the draft choice, and hides absent setup scripts", async () => {
  useComposerDraftStore
    .getState()
    .setDraftThreadContext(threadId, { worktreeBranchName: "single-model" });
  screen = await render(
    <WorktreeCreationOptions threadId={threadId} multiModel hasSetupScript={false} />,
  );
  await page.getByRole("button", { name: "Branch: auto" }).click();
  await expect.element(page.getByRole("textbox", { name: "Branch name" })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect.element(page.getByRole("checkbox")).not.toBeInTheDocument();
  expect(useComposerDraftStore.getState().getDraftThread(threadId)?.worktreeBranchName).toBe(
    "single-model",
  );
});
