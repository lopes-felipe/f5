import type { DesktopBridge, DesktopTrackpadScrollEvent } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { HistorySwipeNavigation } from "./HistorySwipeNavigation";

const router = vi.hoisted(() => ({ history: { back: vi.fn(), forward: vi.fn() } }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouter: () => router,
}));
vi.mock("~/navigationHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/navigationHistory")>()),
  canNavigateHistory: () => true,
}));

let scrollListener: ((event: DesktopTrackpadScrollEvent) => void) | null = null;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  window.desktopBridge = {
    onTrackpadScroll: (listener: (event: DesktopTrackpadScrollEvent) => void) => {
      scrollListener = listener;
      return () => {
        scrollListener = null;
      };
    },
  } as unknown as DesktopBridge;
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  delete window.desktopBridge;
  scrollListener = null;
  vi.clearAllMocks();
});

function mount(element: HTMLElement) {
  document.body.append(element);
  cleanups.push(() => element.remove());
  return element;
}

function wheel(target: EventTarget, deltaX: number, deltaY = 0) {
  target.dispatchEvent(
    new WheelEvent("wheel", { deltaX, deltaY, clientY: 100, bubbles: true, composed: true }),
  );
}

// One trackpad scroll as Chromium reports it: the begin follows the first wheel event.
function scroll(target: EventTarget, deltas: readonly number[], deltaY = 0) {
  const [first, ...rest] = deltas;
  wheel(target, first!, deltaY);
  scrollListener!({ phase: "begin", precise: true });
  for (const delta of rest) wheel(target, delta, deltaY);
  scrollListener!({ phase: "end" });
}

const repeat = (delta: number, count: number) => Array.from({ length: count }, () => delta);

it("goes back once a leftward swipe passes the threshold", async () => {
  await render(<HistorySwipeNavigation />);
  scroll(mount(document.createElement("div")), repeat(-10, 15));
  expect(router.history.back).toHaveBeenCalledTimes(1);
  expect(router.history.forward).not.toHaveBeenCalled();
});

it("goes forward on a rightward swipe", async () => {
  await render(<HistorySwipeNavigation />);
  scroll(mount(document.createElement("div")), repeat(10, 15));
  expect(router.history.forward).toHaveBeenCalledTimes(1);
});

it("does not navigate on a short swipe", async () => {
  await render(<HistorySwipeNavigation />);
  scroll(mount(document.createElement("div")), repeat(-10, 6));
  expect(router.history.back).not.toHaveBeenCalled();
});

it("does not let momentum carry a short swipe past the threshold", async () => {
  await render(<HistorySwipeNavigation />);
  // 40px of finger movement, then a decaying momentum tail that would reach 148px.
  scroll(mount(document.createElement("div")), [-40, -30, -28, -26, -24, -22, -20, -18]);
  expect(router.history.back).not.toHaveBeenCalled();
});

it("ignores vertical scrolls and then recognizes the next swipe", async () => {
  await render(<HistorySwipeNavigation />);
  const target = mount(document.createElement("div"));
  scroll(target, repeat(-10, 15), 40);
  expect(router.history.back).not.toHaveBeenCalled();
  scroll(target, repeat(-10, 15));
  expect(router.history.back).toHaveBeenCalledTimes(1);
});

it("ignores a mouse wheel", async () => {
  await render(<HistorySwipeNavigation />);
  const target = mount(document.createElement("div"));
  wheel(target, -10);
  scrollListener!({ phase: "begin", precise: false });
  for (const delta of repeat(-10, 15)) wheel(target, delta);
  scrollListener!({ phase: "end" });
  expect(router.history.back).not.toHaveBeenCalled();
});

it("leaves sideways scrolling to a scroller inside a shadow root", async () => {
  await render(<HistorySwipeNavigation />);
  const host = mount(document.createElement("div"));
  const scroller = document.createElement("div");
  scroller.style.cssText = "width: 100px; overflow-x: auto;";
  const content = document.createElement("div");
  content.style.cssText = "width: 1000px; height: 10px;";
  scroller.append(content);
  host.attachShadow({ mode: "open" }).append(scroller);
  scroller.scrollLeft = 200;

  scroll(content, repeat(-10, 15));
  expect(router.history.back).not.toHaveBeenCalled();
});

it("does not navigate while a modal alert dialog is open", async () => {
  await render(<HistorySwipeNavigation />);
  const dialog = mount(document.createElement("div"));
  dialog.setAttribute("role", "alertdialog");
  // The wheel lands on the backdrop, outside the dialog element.
  scroll(mount(document.createElement("div")), repeat(-10, 15));
  expect(router.history.back).not.toHaveBeenCalled();
});
