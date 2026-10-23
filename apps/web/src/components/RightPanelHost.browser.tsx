import "../index.css";

import { ThreadId } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useRightPanelStore, type RightPanelSurface } from "../rightPanelStore";
import { RightPanelHost } from "./RightPanelHost";
import { SurfaceErrorBoundary } from "./ui/SurfaceErrorBoundary";

const THREAD_ID = ThreadId.makeUnsafe("thread-panel-boundary");
const noop = () => {};

function Boom(props: { message: string }): never {
  throw new Error(props.message);
}

function Harness(props: { brokenSurfaceIds: ReadonlySet<string> }) {
  const surfaces: RightPanelSurface[] = [
    { id: "diff", kind: "diff" },
    { id: "plan", kind: "plan" },
  ];
  const [activeSurfaceId, setActiveSurfaceId] = useState<string>("diff");
  const [draft, setDraft] = useState("");
  return (
    <div style={{ display: "flex", height: 500 }}>
      <label style={{ width: 300 }}>
        Composer
        <input
          aria-label="Composer"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <div style={{ display: "flex", flexDirection: "column", width: 500 }}>
        <RightPanelHost
          mode="sidebar"
          threadId={THREAD_ID}
          state={{ isOpen: true, activeSurfaceId, surfaces }}
          renderSurface={(surface) =>
            props.brokenSurfaceIds.has(surface.id) ? (
              <Boom message={`${surface.kind} renderer exploded`} />
            ) : (
              <p>{`${surface.kind} body`}</p>
            )
          }
          onActivate={(surface) => setActiveSurfaceId(surface.id)}
          onCloseSurface={noop}
          onCloseOtherSurfaces={noop}
          onCloseSurfacesToRight={noop}
          onCloseAllSurfaces={noop}
          onCopyFilePath={noop}
          onAddPreview={noop}
          onAddFiles={noop}
          onAddDiff={noop}
          onAddPlan={noop}
          onAddAgents={noop}
          previewAvailable={false}
          filesAvailable={false}
          diffAvailable
          planAvailable
          agentsAvailable={false}
          liveAgentCount={0}
        />
      </div>
    </div>
  );
}

describe("right panel error boundaries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("contains a throwing tab while the rest of the app stays interactive", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await render(
      <QueryClientProvider client={new QueryClient()}>
        <Harness brokenSurfaceIds={new Set(["diff"])} />
      </QueryClientProvider>,
    );

    await expect.element(page.getByRole("alert")).toHaveTextContent("diff renderer exploded");
    await expect.element(page.getByRole("button", { name: "Copy error report" })).toBeVisible();

    await userEvent.type(page.getByLabelText("Composer"), "still typing");
    await expect.element(page.getByLabelText("Composer")).toHaveValue("still typing");

    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await expect.element(page.getByText("plan body")).toBeVisible();
    expect(document.querySelector('[data-slot="surface-error"]')).toBeNull();
  });
});

describe("SurfaceErrorBoundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  function Maybe(props: { fail: boolean }) {
    return props.fail ? <Boom message="row failed" /> : <p>row ok</p>;
  }

  it("recovers on Try again and when a reset key changes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const ui = (key: string) => (
      <SurfaceErrorBoundary name="test" resetKeys={[key]}>
        <MaybeReader read={() => fail} />
      </SurfaceErrorBoundary>
    );
    function MaybeReader(props: { read: () => boolean }) {
      return <Maybe fail={props.read()} />;
    }
    const screen = await render(ui("a"));
    await expect.element(page.getByRole("alert")).toHaveTextContent("row failed");

    await page.getByRole("button", { name: "Try again" }).click();
    await expect.element(page.getByRole("alert")).toBeVisible();

    fail = false;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect.element(page.getByText("row ok")).toBeVisible();

    fail = true;
    await screen.rerender(ui("b"));
    await expect.element(page.getByRole("alert")).toBeVisible();
    fail = false;
    await screen.rerender(ui("c"));
    await expect.element(page.getByText("row ok")).toBeVisible();
  });
});

describe("right panel drag order", () => {
  afterEach(() => {
    useRightPanelStore.setState({ byThreadId: {}, closedHistory: [], tabMenuThreadId: null });
    document.body.innerHTML = "";
  });
  function ReorderHarness() {
    const state = useRightPanelStore((store) => store.byThreadId[THREAD_ID]);
    if (!state) return null;
    return (
      <div style={{ height: 500, width: 600 }}>
        <RightPanelHost
          mode="sidebar"
          threadId={THREAD_ID}
          state={state}
          renderSurface={(surface) => <p>{surface.kind} body</p>}
          onActivate={(surface) =>
            useRightPanelStore.getState().activateSurface(THREAD_ID, surface.id)
          }
          onCloseSurface={noop}
          onCloseOtherSurfaces={noop}
          onCloseSurfacesToRight={noop}
          onCloseAllSurfaces={noop}
          onCopyFilePath={noop}
          onAddPreview={noop}
          onAddFiles={noop}
          onAddDiff={noop}
          onAddPlan={noop}
          onAddAgents={noop}
          previewAvailable={false}
          filesAvailable={false}
          diffAvailable
          planAvailable
          agentsAvailable
          liveAgentCount={0}
        />
      </div>
    );
  }
  it("drags a tab to a new position without changing the selected tab", async () => {
    useRightPanelStore.setState({
      byThreadId: {
        [THREAD_ID]: {
          isOpen: true,
          activeSurfaceId: "plan",
          surfaces: [
            { id: "diff", kind: "diff" },
            { id: "plan", kind: "plan" },
            { id: "agents", kind: "agents" },
          ],
        },
      },
    });
    const screen = await render(
      <QueryClientProvider client={new QueryClient()}>
        <ReorderHarness />
      </QueryClientProvider>,
    );
    const from = screen
      .getByRole("button", { name: "Agents", exact: true })
      .element()
      .closest("[draggable='true']")!;
    const to = screen
      .getByRole("button", { name: "Diff", exact: true })
      .element()
      .closest("[draggable='true']")!;
    const transfer = new DataTransfer();
    from.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }));
    to.dispatchEvent(
      new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
    to.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
    await vi.waitFor(() =>
      expect(
        Array.from(document.querySelectorAll("[data-active-tab]")).map(
          (element) => element.querySelector("button")?.textContent,
        ),
      ).toEqual(["Agents", "Diff", "Plan"]),
    );
    expect(useRightPanelStore.getState().byThreadId[THREAD_ID]?.activeSurfaceId).toBe("plan");
  });
});
