import "../index.css";

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import ThreadCyclePicker from "./ThreadCyclePicker";
import UpgradeConnectionDialog from "./UpgradeConnectionDialog";
import {
  Autocomplete,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "./ui/autocomplete";
import { Combobox, ComboboxInput, ComboboxItem, ComboboxList, ComboboxPopup } from "./ui/combobox";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import {
  AnchoredToastProvider,
  anchoredToastManager,
  ToastProvider,
  toastManager,
} from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const POPUP_POSITIONER_SLOTS = [
  "menu-positioner",
  "popover-positioner",
  "select-positioner",
  "combobox-positioner",
  "autocomplete-positioner",
] as const;

function OpenPopups() {
  return (
    <>
      <Menu defaultOpen>
        <MenuTrigger>Menu</MenuTrigger>
        <MenuPopup>
          <MenuItem>Menu item</MenuItem>
        </MenuPopup>
      </Menu>
      <Popover defaultOpen>
        <PopoverTrigger>Popover</PopoverTrigger>
        <PopoverPopup>Popover content</PopoverPopup>
      </Popover>
      <Select defaultOpen defaultValue="a">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="a">Select item</SelectItem>
        </SelectPopup>
      </Select>
      <Combobox defaultOpen items={["Combobox item"]}>
        <ComboboxInput aria-label="Combobox" />
        <ComboboxPopup>
          <ComboboxList>
            {(item: string) => (
              <ComboboxItem key={item} value={item}>
                {item}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
      <Autocomplete defaultOpen items={["Autocomplete item"]}>
        <AutocompleteInput aria-label="Autocomplete" />
        <AutocompletePopup>
          <AutocompleteList>
            {(item: string) => (
              <AutocompleteItem key={item} value={item}>
                {item}
              </AutocompleteItem>
            )}
          </AutocompleteList>
        </AutocompletePopup>
      </Autocomplete>
      <Tooltip defaultOpen>
        <TooltipTrigger>Tooltip</TooltipTrigger>
        <TooltipPopup>Tooltip content</TooltipPopup>
      </Tooltip>
    </>
  );
}

function createTestRouter(content: () => ReactNode) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <ToastProvider>
        <AnchoredToastProvider>{content()}</AnchoredToastProvider>
      </ToastProvider>
    ),
  });
  return createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute.addChildren([indexRoute]),
  });
}

function slotElement(slot: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
  expect(element, `Expected ${slot} to render.`).toBeTruthy();
  return element!;
}

function zIndexOfSlot(slot: string): number {
  return Number(getComputedStyle(slotElement(slot)).zIndex);
}

async function waitForSlots(slots: readonly string[]): Promise<void> {
  await vi.waitFor(
    () => {
      for (const slot of slots) {
        expect(document.querySelector(`[data-slot="${slot}"]`), slot).toBeTruthy();
      }
    },
    { timeout: 4_000, interval: 16 },
  );
}

/** Returns the topmost element at the center of the open menu item. */
function elementOverMenuItem(): Element | null {
  const rect = slotElement("menu-item").getBoundingClientRect();
  return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

afterEach(() => {
  toastManager.close();
  anchoredToastManager.close();
  document.body.innerHTML = "";
});

it("stacks dropdowns and popovers above toasts, and tooltips above both", async () => {
  const anchor = document.createElement("button");
  anchor.textContent = "Anchor";
  document.body.append(anchor);
  const screen = await render(<RouterProvider router={createTestRouter(OpenPopups)} />);
  try {
    toastManager.add({ type: "info", title: "Stacked toast", timeout: 0 });
    anchoredToastManager.add({
      type: "info",
      title: "Anchored toast",
      timeout: 0,
      positionerProps: { anchor },
    });
    await waitForSlots([
      ...POPUP_POSITIONER_SLOTS,
      "tooltip-positioner",
      "toast-viewport",
      "toast-positioner",
    ]);

    const toastZIndex = Math.max(zIndexOfSlot("toast-viewport"), zIndexOfSlot("toast-positioner"));
    const tooltipZIndex = zIndexOfSlot("tooltip-positioner");
    for (const slot of POPUP_POSITIONER_SLOTS) {
      const popupZIndex = zIndexOfSlot(slot);
      expect(popupZIndex, slot).toBeGreaterThan(toastZIndex);
      expect(tooltipZIndex, slot).toBeGreaterThan(popupZIndex);
    }
  } finally {
    await screen.unmount();
  }
});

it("keeps the Ctrl+Tab switcher above a menu that is still open", async () => {
  const screen = await render(
    <RouterProvider
      router={createTestRouter(() => (
        <>
          <OpenPopups />
          <ThreadCyclePicker
            items={[
              {
                id: "settings",
                title: "Settings",
                subtitle: null,
                badgeLabel: null,
                threadStatusPill: null,
                isDraft: false,
                isStale: false,
              },
            ]}
            currentIndex={0}
            currentItemId={null}
            onSelect={() => {}}
            onDismiss={() => {}}
          />
        </>
      ))}
    />,
  );
  try {
    await waitForSlots(["menu-item", "thread-cycle-picker-backdrop"]);
    expect(
      elementOverMenuItem()?.closest('[data-slot="thread-cycle-picker-backdrop"]'),
    ).toBeTruthy();
  } finally {
    await screen.unmount();
  }
});

it("keeps the blocking upgrade dialog above a menu that is still open", async () => {
  const screen = await render(
    <RouterProvider
      router={createTestRouter(() => (
        <>
          <OpenPopups />
          <UpgradeConnectionDialog title="Update required" description="Reload" fallback={null}>
            <button type="button">Reload</button>
          </UpgradeConnectionDialog>
        </>
      ))}
    />,
  );
  try {
    await waitForSlots(["menu-item", "dialog-viewport"]);
    expect(
      elementOverMenuItem()?.closest(
        '[data-slot="dialog-viewport"], [data-slot="dialog-backdrop"]',
      ),
    ).toBeTruthy();
  } finally {
    await screen.unmount();
  }
});
