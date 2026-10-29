export const PREVIEW_PICK_INPUT_LAYER_ATTRIBUTE = "data-f5-preview-pick-input";

export function buildPreviewPickScript(): string {
  return String.raw`
(() => {
  if (window.__f5PreviewPickCancel) {
    window.__f5PreviewPickCancel();
  }

  const selectorFor = (element) => {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
    if (element.id) return "#" + CSS.escape(element.id);
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
      let part = current.localName;
      if (!part) break;
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.localName === current.localName);
        if (siblings.length > 1) {
          part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
        }
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.length > 0 ? parts.join(" > ") : null;
  };

  const previewText = (value, limit) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #2563eb;background:rgba(37,99,235,.12);box-shadow:0 0 0 99999px rgba(15,23,42,.18);border-radius:4px;display:none;";
    const label = document.createElement("div");
    label.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;background:#2563eb;color:white;font:12px system-ui,sans-serif;padding:3px 6px;border-radius:4px;display:none;max-width:320px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    // Chromium draws a PDF in its own viewer frame, so pointer and key input over it
    // never reaches this document. A transparent layer above the viewer catches the
    // pointer and takes focus so Escape still cancels.
    const inputLayer = document.contentType === "application/pdf" ? document.createElement("div") : null;
    if (inputLayer) {
      inputLayer.setAttribute("${PREVIEW_PICK_INPUT_LAYER_ATTRIBUTE}", "");
      inputLayer.tabIndex = -1;
      inputLayer.style.cssText = "position:fixed;inset:0;z-index:2147483646;cursor:crosshair;outline:none;background:transparent;";
      document.documentElement.append(inputLayer);
    }
    document.documentElement.append(overlay, label);
    inputLayer?.focus({ preventScroll: true });

    const targetOf = (event) => {
      if (!inputLayer || event.target !== inputLayer) return event.target;
      for (const candidate of document.elementsFromPoint(event.clientX, event.clientY)) {
        if (candidate === inputLayer || candidate === overlay || candidate === label) continue;
        return candidate;
      }
      return null;
    };

    const cleanup = () => {
      window.__f5PreviewPickCancel = undefined;
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKeyDown, true);
      inputLayer?.remove();
      overlay.remove();
      label.remove();
    };

    const finish = (value) => {
      cleanup();
      resolve(value);
    };

    const update = (target) => {
      if (!target || target === document.documentElement || target === document.body) {
        overlay.style.display = "none";
        label.style.display = "none";
        return;
      }
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      overlay.style.display = "block";
      overlay.style.left = rect.left + "px";
      overlay.style.top = rect.top + "px";
      overlay.style.width = rect.width + "px";
      overlay.style.height = rect.height + "px";
      label.style.display = "block";
      label.textContent = target.localName + (target.id ? "#" + target.id : "");
      label.style.left = Math.max(8, Math.min(window.innerWidth - 120, rect.left)) + "px";
      label.style.top = Math.max(8, rect.top - 28) + "px";
    };

    function onMove(event) {
      update(targetOf(event));
    }

    function onClick(event) {
      event.preventDefault();
      event.stopPropagation();
      const target = targetOf(event);
      if (!target || target.nodeType !== Node.ELEMENT_NODE) {
        finish(null);
        return;
      }
      const rect = target.getBoundingClientRect();
      const pageUrl = location.href;
      const pageTitle = document.title || null;
      finish({
        pageUrl,
        pageTitle,
        viewport: {
          width: Math.max(1, Math.floor(window.innerWidth || 1)),
          height: Math.max(1, Math.floor(window.innerHeight || 1))
        },
        rect: {
          x: Math.max(0, Math.floor(rect.x)),
          y: Math.max(0, Math.floor(rect.y)),
          width: Math.max(1, Math.ceil(rect.width)),
          height: Math.max(1, Math.ceil(rect.height))
        },
        element: {
          pageUrl,
          pageTitle,
          tagName: target.localName || "",
          selector: selectorFor(target),
          htmlPreview: previewText(target.outerHTML, 1600),
          textPreview: previewText(target.innerText || target.textContent, 500),
          pickedAt: new Date().toISOString()
        }
      });
    }

    function onKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      }
    }

    window.__f5PreviewPickCancel = () => finish(null);
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKeyDown, true);
  });
})()
`;
}
