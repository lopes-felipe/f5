export const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
export const THREAD_SIDEBAR_MIN_WIDTH_PX = 12 * 16;
export const THREAD_SIDEBAR_MAX_WIDTH_PX = 32 * 16;
export const THREAD_MAIN_PANEL_MIN_WIDTH_PX = 32 * 16;
const THREAD_SIDEBAR_DEFAULT_WIDTH_PX = 16 * 16;

export function clampThreadSidebarWidth(width: number): number {
  return Math.max(THREAD_SIDEBAR_MIN_WIDTH_PX, Math.min(width, THREAD_SIDEBAR_MAX_WIDTH_PX));
}

export function readThreadSidebarWidthFromStorage(storage: Pick<Storage, "getItem">): number {
  try {
    const storedWidthValue = storage.getItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY);
    const storedWidth =
      storedWidthValue === null ? Number.NaN : Number.parseFloat(storedWidthValue);
    return clampThreadSidebarWidth(
      Number.isFinite(storedWidth) ? storedWidth : THREAD_SIDEBAR_DEFAULT_WIDTH_PX,
    );
  } catch {
    return THREAD_SIDEBAR_DEFAULT_WIDTH_PX;
  }
}

export function readInitialThreadSidebarWidth(): number {
  if (typeof window === "undefined") {
    return THREAD_SIDEBAR_DEFAULT_WIDTH_PX;
  }

  return readThreadSidebarWidthFromStorage(window.localStorage);
}

export function canAcceptThreadSidebarWidth(input: {
  nextWidth: number;
  wrapper: HTMLElement;
}): boolean {
  const mainPane = input.wrapper.querySelector<HTMLElement>("main[data-slot='sidebar-inset']");
  if (!mainPane) {
    return true;
  }

  const previousSidebarWidth = input.wrapper.style.getPropertyValue("--sidebar-width");
  input.wrapper.style.setProperty("--sidebar-width", `${input.nextWidth}px`);
  try {
    const mainPaneWidth = mainPane.getBoundingClientRect().width;
    return mainPaneWidth + 0.5 >= THREAD_MAIN_PANEL_MIN_WIDTH_PX;
  } finally {
    if (previousSidebarWidth.length > 0) {
      input.wrapper.style.setProperty("--sidebar-width", previousSidebarWidth);
    } else {
      input.wrapper.style.removeProperty("--sidebar-width");
    }
  }
}

export function resolveAcceptedThreadSidebarWidth(input: {
  preferredWidth: number;
  wrapper: HTMLElement;
}): number {
  const preferredWidth = clampThreadSidebarWidth(input.preferredWidth);
  if (canAcceptThreadSidebarWidth({ nextWidth: preferredWidth, wrapper: input.wrapper })) {
    return preferredWidth;
  }

  let low = THREAD_SIDEBAR_MIN_WIDTH_PX;
  let high = preferredWidth;
  let best = THREAD_SIDEBAR_MIN_WIDTH_PX;

  if (!canAcceptThreadSidebarWidth({ nextWidth: low, wrapper: input.wrapper })) {
    return best;
  }

  while (low <= high) {
    const candidateWidth = Math.floor((low + high) / 2);
    if (canAcceptThreadSidebarWidth({ nextWidth: candidateWidth, wrapper: input.wrapper })) {
      best = candidateWidth;
      low = candidateWidth + 1;
    } else {
      high = candidateWidth - 1;
    }
  }

  return best;
}
