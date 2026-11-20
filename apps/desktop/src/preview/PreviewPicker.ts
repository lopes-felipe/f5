import { taggedAutomationError } from "./automationControl";
import {
  buildCancelPreviewPickScript,
  buildPreviewPickScript,
  PREVIEW_PICK_WORLD_ID,
} from "./pickScript";

const documentEndEvents = ["did-navigate", "destroyed", "render-process-gone"] as const;
type DocumentEndEvent = (typeof documentEndEvents)[number];

type PickerGuest = Pick<
  Electron.WebContents,
  "executeJavaScriptInIsolatedWorld" | "getURL" | "isLoadingMainFrame"
> & {
  once(event: DocumentEndEvent, listener: () => void): unknown;
  off(event: DocumentEndEvent, listener: () => void): unknown;
};

interface ActivePicks {
  readonly ids: Set<number>;
  readonly documentClosed: Promise<null>;
  readonly onDocumentClosed: () => void;
  latestId: number;
}

export class PreviewPicker {
  private readonly active = new WeakMap<PickerGuest, ActivePicks>();
  private nextId = 0;

  assertAutomationAllowed(guest: PickerGuest): void {
    if (this.active.has(guest)) {
      throw taggedAutomationError(
        "PreviewAutomationControlInterruptedError",
        "The user is picking an element in the browser preview.",
      );
    }
  }

  async pick(guest: PickerGuest, automationActive: boolean): Promise<unknown> {
    if (automationActive) {
      throw new Error("Wait for the current browser automation action to finish before picking.");
    }
    // Electron can defer script execution until navigation finishes.
    if (!guest.getURL() || guest.isLoadingMainFrame()) {
      throw new Error("Wait for the preview page to finish loading before picking.");
    }
    const id = ++this.nextId;
    const active = this.active.get(guest) ?? this.trackDocument(guest, id);
    active.ids.add(id);
    active.latestId = id;
    try {
      // The script replaces any previous overlay in the isolated world.
      const result: unknown = await Promise.race([
        this.evaluate(guest, buildPreviewPickScript(id)),
        active.documentClosed,
      ]);
      return this.active.get(guest) === active && active.latestId === id ? result : null;
    } finally {
      active.ids.delete(id);
      if (active.ids.size === 0 && this.active.get(guest) === active) {
        this.untrackDocument(guest, active);
      }
    }
  }

  async cancel(guest: PickerGuest): Promise<void> {
    const active = this.active.get(guest);
    if (!active) return;
    // A deferred cancellation belongs only to the picks pending when it was requested.
    await Promise.race([
      this.evaluate(guest, buildCancelPreviewPickScript([...active.ids])),
      active.documentClosed,
    ]);
  }

  private evaluate(guest: PickerGuest, code: string): Promise<unknown> {
    return guest.executeJavaScriptInIsolatedWorld(PREVIEW_PICK_WORLD_ID, [{ code }]);
  }

  private trackDocument(guest: PickerGuest, id: number): ActivePicks {
    let resolveClosed!: (value: null) => void;
    const active: ActivePicks = {
      ids: new Set(),
      latestId: id,
      documentClosed: new Promise<null>((resolve) => {
        resolveClosed = resolve;
      }),
      onDocumentClosed: () => {
        this.untrackDocument(guest, active);
        resolveClosed(null);
      },
    };
    this.active.set(guest, active);
    for (const event of documentEndEvents) guest.once(event, active.onDocumentClosed);
    return active;
  }

  private untrackDocument(guest: PickerGuest, active: ActivePicks): void {
    for (const event of documentEndEvents) guest.off(event, active.onDocumentClosed);
    this.active.delete(guest);
  }
}
