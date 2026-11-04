import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { RememberedComputerConsentEntry } from "@t3tools/contracts";
import { RememberedComputerApps } from "./RememberedComputerApps";

const fixture = vi.hoisted(() => ({
  projects: [{ id: "project", name: "My project <untrusted>" }],
}));
vi.mock("../../store", () => ({
  useStore: (select: (state: typeof fixture) => unknown) => select(fixture),
}));
vi.mock("../../nativeApi", () => ({ readNativeApi: () => undefined }));
afterEach(() => {
  delete window.desktopBridge;
});

it("groups saved choices by project and profile, shows run-only failures, and revokes the exact policy", async () => {
  let entries: RememberedComputerConsentEntry[] = [
    {
      consent: {
        version: 1,
        kind: "app-access",
        projectId: "project",
        appId: "TextEdit",
        tier: "full",
        allowTyping: false,
        policyVersion: 1,
      },
      persistence: "durable",
    },
    {
      consent: {
        version: 1,
        kind: "session-actions",
        projectId: "removed",
        background: true,
        policyVersion: 1,
      },
      persistence: "session-only",
      reason: "Disk full",
    },
    {
      consent: { version: 1, kind: "full-access-session", policyVersion: 1 },
      persistence: "durable",
    },
  ];
  const load = vi.fn(async () => entries);
  const revoke = vi.fn(async (consent: RememberedComputerConsentEntry["consent"]) => {
    entries = entries.filter((entry) => entry.consent !== consent);
  });
  window.desktopBridge = {
    computerAutomation: {
      rememberedComputerConsents: load,
      revokeRememberedComputerConsent: revoke,
    },
  } as never;
  const screen = await render(<RememberedComputerApps />);
  try {
    await expect.element(page.getByText("My project <untrusted>", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Unlinked projects", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("Session approval in Full access threads", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByText("Background and foreground · Until F5 closes. Disk full"))
      .toBeVisible();
    await page.getByRole("button", { name: "Revoke", exact: true }).nth(0).click();
    expect(revoke).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "app-access",
        projectId: "project",
        appId: "TextEdit",
      }),
    );
    await expect.element(page.getByText("TextEdit", { exact: true })).not.toBeInTheDocument();
    entries = [];
    window.dispatchEvent(new Event("focus"));
    await expect
      .element(page.getByText("No remembered permissions.", { exact: true }))
      .toBeVisible();
  } finally {
    await screen.unmount();
  }
});

it("surfaces native revocation failure without the IPC wrapper", async () => {
  window.desktopBridge = {
    computerAutomation: {
      rememberedComputerConsents: async () => [
        {
          consent: { version: 1, kind: "full-access-session", policyVersion: 1 },
          persistence: "durable",
        },
      ],
      revokeRememberedComputerConsent: async () => {
        throw new Error(
          "Error invoking remote method 'desktop-computer:revoke-remembered-consent': Error: A restart could restore this permission.",
        );
      },
    },
  } as never;
  const screen = await render(<RememberedComputerApps />);
  try {
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("A restart could restore this permission.");
    expect(page.getByRole("alert").element().textContent).not.toContain("remote method");
  } finally {
    await screen.unmount();
  }
});

it("keeps remote settings read-only", async () => {
  const screen = await render(<RememberedComputerApps />);
  try {
    await expect
      .element(page.getByText("Manage permissions on the computer running F5."))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});
