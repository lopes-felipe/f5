import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { HookApprovalWorkEntryRow } from "./HookApprovalWorkEntryRow";

const mocks = vi.hoisted(() => ({
  threads: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../store", () => ({
  useStore: (select: (state: unknown) => unknown) => select({ threads: mocks.threads }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: (props: { search: Record<string, unknown>; children: ReactNode; className?: string }) => (
    <a data-search={JSON.stringify(props.search)} className={props.className}>
      {props.children}
    </a>
  ),
}));

const THREAD = ThreadId.makeUnsafe("thread-1");

afterEach(() => {
  mocks.threads = [];
  document.body.innerHTML = "";
});

function linkSearch() {
  const link = page.getByText("Review hooks").element();
  return JSON.parse(link.getAttribute("data-search") ?? "{}") as Record<string, unknown>;
}

it("links to the instance that refused the hooks, scoped to the thread's project", async () => {
  mocks.threads = [
    {
      id: THREAD,
      projectId: "project-1",
      session: { providerInstanceId: "codex_personal" },
    },
  ];
  const screen = await render(
    <HookApprovalWorkEntryRow
      label="2 hooks need approval"
      threadId={THREAD}
      instanceId="codex_work"
    >
      <p>failures</p>
    </HookApprovalWorkEntryRow>,
  );
  try {
    await expect.element(page.getByText("Review hooks")).toBeVisible();
    expect(linkSearch()).toEqual({
      category: "providers",
      item: "providers.instances",
      instance: "codex_work",
      instanceProject: "project-1",
    });
    await page.getByRole("button", { name: /Show the failed hooks/ }).click();
    await expect.element(page.getByText("failures")).toBeVisible();
    await expect
      .element(page.getByText(/keeps skipping these hooks until its session restarts/))
      .toBeVisible();
  } finally {
    await screen.unmount();
  }
});

it("falls back to the thread's instance and hides the link without one", async () => {
  mocks.threads = [{ id: THREAD, projectId: "project-1", modelSelection: { instanceId: "codex" } }];
  const screen = await render(
    <HookApprovalWorkEntryRow label="1 hook needs approval" threadId={THREAD}>
      <p>failures</p>
    </HookApprovalWorkEntryRow>,
  );
  try {
    expect(linkSearch()).toMatchObject({ instance: "codex" });
  } finally {
    await screen.unmount();
  }
  const orphan = await render(
    <HookApprovalWorkEntryRow label="1 hook needs approval" threadId={null}>
      <p>failures</p>
    </HookApprovalWorkEntryRow>,
  );
  try {
    await expect.element(page.getByText("1 hook needs approval")).toBeVisible();
    await expect.element(page.getByText("Review hooks")).not.toBeInTheDocument();
  } finally {
    await orphan.unmount();
  }
});
