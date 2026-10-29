import "../../index.css";

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  Autocomplete,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "./autocomplete";
import { Combobox, ComboboxInput, ComboboxItem, ComboboxList, ComboboxPopup } from "./combobox";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./menu";
import { Popover, PopoverPopup, PopoverTrigger } from "./popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./select";
import { ToastProvider, toastManager } from "./toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

const POPUP_POSITIONER_SLOTS = [
  "menu-positioner",
  "popover-positioner",
  "select-positioner",
  "combobox-positioner",
  "autocomplete-positioner",
] as const;

function OpenPopups() {
  return (
    <ToastProvider>
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
    </ToastProvider>
  );
}

function createTestRouter() {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: OpenPopups,
  });
  return createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute.addChildren([indexRoute]),
  });
}

function zIndexOfSlot(slot: string): number {
  const element = document.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
  expect(element, `Expected ${slot} to render.`).toBeTruthy();
  return Number(getComputedStyle(element!).zIndex);
}

afterEach(() => {
  toastManager.close();
  document.body.innerHTML = "";
});

it("stacks dropdowns and popovers above toasts, and tooltips above both", async () => {
  const screen = await render(<RouterProvider router={createTestRouter()} />);
  try {
    toastManager.add({ type: "info", title: "Layering toast", timeout: 0 });
    await vi.waitFor(
      () => {
        for (const slot of [...POPUP_POSITIONER_SLOTS, "tooltip-positioner", "toast-viewport"]) {
          expect(document.querySelector(`[data-slot="${slot}"]`), slot).toBeTruthy();
        }
        expect(document.querySelector('[data-slot="toast-title"]')).toBeTruthy();
      },
      { timeout: 4_000, interval: 16 },
    );

    const toastZIndex = zIndexOfSlot("toast-viewport");
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
