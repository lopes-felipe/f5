import { BrowserWindow, screen } from "electron";
import type {
  ComputerAutomationRequest,
  ComputerDisplay,
  ComputerLeaseHolder,
} from "@t3tools/contracts";
import { computerModelToNative } from "@t3tools/shared/computerGeometry";
import type { ComputerOverlaySurface, ComputerOverlayTarget } from "./ComputerController";

const DOCUMENT = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;pointer-events:none}body{box-sizing:border-box;border:2px solid var(--accent);box-shadow:inset 0 0 14px var(--accent)}#cursor{position:absolute;left:0;top:0;transition:transform 180ms ease-out;color:var(--accent);font:12px system-ui}#label{color:white;background:var(--accent);border-radius:8px;padding:4px 8px;white-space:nowrap;margin:3px 0 0 15px}#point{font-size:25px;text-shadow:0 1px 3px black}#ripple{position:absolute;width:30px;height:30px;border:2px solid var(--accent);border-radius:50%;transform:translate(-50%,-50%);animation:ripple .5s ease-out forwards}@keyframes ripple{to{opacity:0;scale:1.8}}@media(prefers-reduced-motion:reduce){#cursor{transition:none}#ripple{animation:none}}
#outline{position:absolute;border:2px dashed var(--accent);border-radius:4px;box-sizing:border-box}svg{position:absolute;inset:0;width:100%;height:100%}line{stroke:var(--accent);stroke-width:3;stroke-dasharray:5 5;opacity:.7}
</style></head><body><div id="outline" hidden></div><svg><line id="trail"/></svg><div id="cursor"><div id="point">➤</div><div id="label"></div></div><script>
window.drawComputerAction=(action)=>{document.body.style.setProperty('--accent',action.provider==='claude'?'#D97757':'#10A37F');document.getElementById('label').textContent=action.label;const cursor=document.getElementById('cursor');cursor.style.transform='translate('+action.x+'px,'+action.y+'px)';document.getElementById('point').style.display=action.point?'block':'none';cursor.style.transition=action.animate?'transform 180ms ease-out':'none';const outline=document.getElementById('outline');outline.hidden=!action.outline;if(action.outline){for(const key of ['left','top','width','height'])outline.style[key]=action.outline[key]+'px'}const trail=document.getElementById('trail');trail.style.display=action.from?'block':'none';if(action.from){trail.setAttribute('x1',action.from.x);trail.setAttribute('y1',action.from.y);trail.setAttribute('x2',action.x);trail.setAttribute('y2',action.y)}if(action.click){const ripple=document.createElement('div');ripple.id='ripple';ripple.style.left=action.x+'px';ripple.style.top=action.y+'px';document.body.append(ripple);setTimeout(()=>ripple.remove(),550)}};
</script></body></html>`;
export class ComputerOverlay implements ComputerOverlaySurface {
  private readonly windows = new Map<string, BrowserWindow>();
  private holder: ComputerLeaseHolder | undefined;
  private lastPoint: { x: number; y: number } | undefined;
  private readonly rebuild = () => {
    const holder = this.holder;
    this.clear();
    if (holder) this.show(holder);
  };
  constructor() {
    screen.on("display-added", this.rebuild);
    screen.on("display-removed", this.rebuild);
    screen.on("display-metrics-changed", this.rebuild);
  }
  show(holder: ComputerLeaseHolder): void {
    this.holder = holder;
    for (const display of screen.getAllDisplays()) {
      const window = new BrowserWindow({
        ...display.bounds,
        transparent: true,
        frame: false,
        focusable: false,
        skipTaskbar: true,
        hasShadow: false,
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          devTools: false,
        },
      });
      window.setAlwaysOnTop(true, "screen-saver");
      window.setIgnoreMouseEvents(true);
      window.setContentProtection(true);
      if (process.platform === "darwin")
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      void window
        .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(DOCUMENT)}`)
        .then(() => {
          if (!window.isDestroyed()) window.showInactive();
        });
      this.windows.set(String(display.id), window);
    }
  }
  async action(
    request: ComputerAutomationRequest,
    displays: ReadonlyArray<ComputerDisplay>,
    target?: ComputerOverlayTarget,
  ): Promise<void> {
    let point: { x: number; y: number } | undefined;
    let from: { x: number; y: number } | undefined;
    let outline: { left: number; top: number; width: number; height: number } | undefined;
    const displayId = "displayId" in request ? request.displayId : target?.displayId;
    const display = displays.find((entry) => entry.displayId === displayId);
    if (display && ("x" in request || request.op === "drag")) {
      const coords = request.op === "drag" ? request.to : (request as { x: number; y: number });
      const native = computerModelToNative(
        display,
        coords.x,
        coords.y,
        process.platform === "win32" ? "win32" : "darwin",
      );
      point = process.platform === "win32" ? screen.screenToDipPoint(native) : native;
    }
    if (display && request.op === "drag") {
      const native = computerModelToNative(
        display,
        request.from.x,
        request.from.y,
        process.platform === "win32" ? "win32" : "darwin",
      );
      from = process.platform === "win32" ? screen.screenToDipPoint(native) : native;
    }
    if (display && target?.bounds) {
      const bounds = target.bounds;
      const a = {
        x:
          display.nativeBounds.x +
          (bounds.x * display.nativeBounds.width) / display.modelSize.width,
        y:
          display.nativeBounds.y +
          (bounds.y * display.nativeBounds.height) / display.modelSize.height,
      };
      const b = {
        x: a.x + (bounds.width * display.nativeBounds.width) / display.modelSize.width,
        y: a.y + (bounds.height * display.nativeBounds.height) / display.modelSize.height,
      };
      const start = process.platform === "win32" ? screen.screenToDipPoint(a) : a;
      const end = process.platform === "win32" ? screen.screenToDipPoint(b) : b;
      outline = { left: start.x, top: start.y, width: end.x - start.x, height: end.y - start.y };
    }
    const animate =
      !!point &&
      (!this.lastPoint || Math.hypot(point.x - this.lastPoint.x, point.y - this.lastPoint.y) >= 4);
    for (const window of this.windows.values()) {
      const bounds = window.getBounds();
      const here =
        point &&
        point.x >= bounds.x &&
        point.x < bounds.x + bounds.width &&
        point.y >= bounds.y &&
        point.y < bounds.y + bounds.height;
      const action = {
        provider: request.agent.provider,
        label: `${request.agent.provider === "claude" ? "Claude" : "Codex"}${target?.appName ? ` · ${target.appName}` : ""} · ${request.op === "type" ? `Typing ${request.text.length} characters` : request.op === "key" ? request.chords.join(" → ").slice(0, 80) : request.op === "elementAction" ? request.action : request.op}`,
        point: !!here,
        x: here && point ? point.x - bounds.x : 16,
        y: here && point ? point.y - bounds.y : 16,
        click: here && request.op === "click",
        animate,
        ...(here && from ? { from: { x: from.x - bounds.x, y: from.y - bounds.y } } : {}),
        ...(outline
          ? { outline: { ...outline, left: outline.left - bounds.x, top: outline.top - bounds.y } }
          : {}),
      };
      if (!window.isDestroyed())
        await window.webContents
          .executeJavaScript(`window.drawComputerAction(${JSON.stringify(action)})`)
          .catch(() => undefined);
    }
    // Bounded cursor animation; authorization is rechecked after this wait.
    if (animate) await new Promise<void>((resolve) => setTimeout(resolve, 180));
    if (point) this.lastPoint = point;
  }
  windowIds(): ReadonlyArray<number> {
    return [...this.windows.values()]
      .filter((window) => !window.isDestroyed())
      .map((window) => {
        if (process.platform === "darwin") {
          const id = Number(window.getMediaSourceId().split(":")[1]);
          return Number.isSafeInteger(id) ? id : 0;
        }
        const handle = window.getNativeWindowHandle();
        return handle.length >= 8 ? Number(handle.readBigUInt64LE()) : handle.readUInt32LE();
      });
  }
  clear(): void {
    this.holder = undefined;
    this.lastPoint = undefined;
    for (const window of this.windows.values()) if (!window.isDestroyed()) window.close();
    this.windows.clear();
  }
  close(): void {
    this.clear();
    screen.off("display-added", this.rebuild);
    screen.off("display-removed", this.rebuild);
    screen.off("display-metrics-changed", this.rebuild);
  }
}
