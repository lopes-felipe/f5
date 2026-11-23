import "../index.css";

import type { ProjectRepository } from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  PlainGroupWorkspacePicker,
  resolveWorktreeRepositorySelection,
  WorktreeRepositoryPicker,
} from "./RepositoryPicker";

function repositories(count: number): ProjectRepository[] {
  return Array.from({ length: count }, (_, index) => {
    const relativePath = `repo-${String(index).padStart(3, "0")}`;
    return { path: `/workspace/${relativePath}`, relativePath } as ProjectRepository;
  });
}

function PlainHarness(props: {
  repositories: ReadonlyArray<ProjectRepository>;
  initialSelected?: ReadonlyArray<string>;
  onState?: (state: { worktree: boolean; selected: ReadonlyArray<string> | undefined }) => void;
}) {
  const [worktree, setWorktree] = useState(false);
  const [selected, setSelected] = useState(props.initialSelected);
  const [base, setBase] = useState("");
  props.onState?.({ worktree, selected });
  return (
    <PlainGroupWorkspacePicker
      projectCwd="/workspace"
      worktree={worktree}
      onWorktreeChange={setWorktree}
      repositories={props.repositories}
      selected={selected}
      onSelectedChange={setSelected}
      baseBranch={base}
      onBaseBranchChange={setBase}
    />
  );
}

describe("resolveWorktreeRepositorySelection", () => {
  it("includes every repository in small projects and none in large ones without a saved choice", () => {
    expect(resolveWorktreeRepositorySelection(repositories(8), undefined, true)).toHaveLength(8);
    expect(resolveWorktreeRepositorySelection(repositories(8), undefined, false)).toHaveLength(0);
    expect(resolveWorktreeRepositorySelection(repositories(109), undefined, true)).toHaveLength(0);
    expect(resolveWorktreeRepositorySelection(repositories(109), ["repo-001"], true)).toEqual([
      "repo-001",
    ]);
  });
});

describe("PlainGroupWorkspacePicker", () => {
  it("starts in the project folder and opts into a worktree from the picker", async () => {
    let latest: { worktree: boolean; selected: ReadonlyArray<string> | undefined } | undefined;
    const screen = await render(
      <PlainHarness repositories={repositories(109)} onState={(state) => (latest = state)} />,
    );
    try {
      await expect
        .element(page.getByRole("button", { name: "Workspace: Local" }))
        .toBeInTheDocument();
      await page.getByRole("button", { name: "Workspace: Local" }).click();
      await expect.element(page.getByText("Project folder")).toBeVisible();
      await expect.element(page.getByLabelText("Search repositories")).not.toBeInTheDocument();

      await page.getByRole("menuitemradio", { name: /New worktree/ }).click();
      expect(latest?.worktree).toBe(true);
      await expect.element(page.getByText("Repositories · 0 of 109")).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Workspace: New worktree · pick repositories" }))
        .toBeInTheDocument();

      await userEvent.fill(page.getByLabelText("Search repositories"), "repo-10");
      const group = page.getByRole("group", { name: "Repositories" });
      await expect.element(group.getByText("repo-100")).toBeVisible();
      expect(group.element().querySelectorAll('[data-slot="checkbox"]')).toHaveLength(9);
      await group.getByText("repo-104").click();
      await page.getByRole("button", { name: "Select matches" }).click();
      expect(latest?.selected).toHaveLength(9);
      await expect.element(page.getByText("Repositories · 9 of 109")).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Workspace: New worktree · 9 repos" }))
        .toBeInTheDocument();

      await page.getByRole("button", { name: "Clear" }).click();
      expect(latest?.selected).toEqual([]);

      await page.getByRole("menuitemradio", { name: /Project folder/ }).click();
      expect(latest?.worktree).toBe(false);
      await expect
        .element(page.getByRole("button", { name: "Workspace: Local" }))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("restores a remembered selection and preselects small groups", async () => {
    const remembered = await render(
      <PlainHarness repositories={repositories(109)} initialSelected={["repo-002", "repo-050"]} />,
    );
    try {
      await page.getByRole("button", { name: "Workspace: Local" }).click();
      await page.getByRole("menuitemradio", { name: /New worktree/ }).click();
      await expect
        .element(page.getByRole("button", { name: "Workspace: New worktree · 2 repos" }))
        .toBeInTheDocument();
    } finally {
      await remembered.unmount();
    }

    const small = await render(<PlainHarness repositories={repositories(3)} />);
    try {
      await page.getByRole("button", { name: "Workspace: Local" }).click();
      await page.getByRole("menuitemradio", { name: /New worktree/ }).click();
      await expect.element(page.getByText("Repositories · 3 of 3")).toBeVisible();
      await expect.element(page.getByLabelText("Search repositories")).not.toBeInTheDocument();
    } finally {
      await small.unmount();
    }
  });
});

describe("WorktreeRepositoryPicker", () => {
  it("renders nothing without nested repositories and a compact trigger otherwise", async () => {
    const empty = await render(
      <WorktreeRepositoryPicker repositories={[]} selected={undefined} onChange={() => {}} />,
    );
    expect(empty.container.textContent).toBe("");
    await empty.unmount();

    const screen = await render(
      <WorktreeRepositoryPicker
        repositories={repositories(3)}
        selected={undefined}
        onChange={() => {}}
      />,
    );
    try {
      await expect.element(page.getByText("Repositories · 3")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
