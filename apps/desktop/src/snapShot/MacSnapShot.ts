import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { DesktopSnapShotResult } from "@t3tools/contracts";
export interface SnapShotImage {
  getSize(): { width: number; height: number };
  resize(options: { width?: number; height?: number }): SnapShotImage;
  toPNG(): Buffer;
}
function execute(
  file: string,
  args: string[],
  timeout: number,
  maxBuffer: number,
): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(file, args, { timeout, maxBuffer }, (error, stdout) =>
      error
        ? reject(
            new Error(
              "Capture failed. Check Screen Recording and Accessibility permissions in System Settings.",
            ),
          )
        : resolve(stdout),
    ),
  );
}
export function activeWindowScript(pid: number): string {
  return `ObjC.import('CoreGraphics'); ObjC.import('Foundation'); const windows=ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(1,0)); const w=windows.find(w=>w.kCGWindowLayer===0 && w.kCGWindowOwnerPID!==${pid} && w.kCGWindowOwnerPID!==0 && w.kCGWindowBounds.Width>0 && w.kCGWindowBounds.Height>0); JSON.stringify(w?{id:w.kCGWindowNumber,pid:w.kCGWindowOwnerPID,title:w.kCGWindowName||'',app:w.kCGWindowOwnerName||''}:null);`;
}
export function accessibilityScript(pid: number): string {
  return `const app=Application('System Events'); const processes=app.processes.whose({unixId:${pid}})(); let text='',visited=0; function walk(node,depth){if(++visited>2000||depth>40||text.length>=20000)return; try{const role=node.role(),name=node.name();if(name)text+=(role+': '+String(name).slice(0,500)+'\\n'); const children=node.uiElements();for(const child of children){if(visited>=2000||text.length>=20000)break;walk(child,depth+1);}}catch{}} if(processes.length){for(const w of processes[0].windows()){if(visited>=2000||text.length>=20000)break;walk(w,0);}}text.slice(0,20000);`;
}
export async function captureMacWindow(options: {
  pid: number;
  image: (bytes: Buffer) => SnapShotImage;
  focus: () => void;
  execute?: typeof execute;
}): Promise<DesktopSnapShotResult> {
  const run = options.execute ?? execute;
  const window: unknown = JSON.parse(
    await run(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", activeWindowScript(options.pid)],
      3000,
      64 * 1024,
    ),
  );
  if (
    !window ||
    typeof window !== "object" ||
    !("id" in window) ||
    !Number.isSafeInteger(window.id) ||
    Number(window.id) <= 0 ||
    !("pid" in window) ||
    !Number.isSafeInteger(window.pid)
  )
    throw new Error("No non-F5 window is available to capture.");
  const info = window as { id: number; pid: number; title?: string; app?: string };
  const directory = await mkdtemp(path.join(os.tmpdir(), "f5-snapshot-"));
  try {
    const file = path.join(directory, "window.png");
    await run(
      "/usr/sbin/screencapture",
      ["-l", String(info.id), "-o", "-x", "-t", "png", file],
      10000,
      4096,
    );
    const bytes = await readFile(file);
    if (bytes.length > 100 * 1024 * 1024) throw new Error("Captured image exceeds the limit.");
    let image = options.image(bytes);
    const size = image.getSize();
    if (!size.width || !size.height) throw new Error("The captured image is empty.");
    if (Math.max(size.width, size.height) > 2560)
      image = image.resize(size.width >= size.height ? { width: 2560 } : { height: 2560 });
    const context = await run(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", accessibilityScript(info.pid)],
      3000,
      96 * 1024,
    ).catch(() => "Accessibility text unavailable. Grant Accessibility permission to F5.");
    const png = image.toPNG();
    if (png.length > 25 * 1024 * 1024) throw new Error("Captured image exceeds the size limit.");
    options.focus();
    return {
      image: { name: "window.png", mimeType: "image/png", bytes: new Uint8Array(png) },
      context: {
        name: "window-context.txt",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode(
          `${String(info.app ?? "").slice(0, 500)} — ${String(info.title ?? "").slice(0, 1000)}\n${context.slice(0, 20000)}`.slice(
            0,
            20000,
          ),
        ),
      },
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
