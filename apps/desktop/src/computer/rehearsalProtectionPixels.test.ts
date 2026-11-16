import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Actual Swift bitmap decoding/region checks; no screen, permission or app access.
describe.runIf(process.platform === "darwin")("protection pixel verifier", () => {
  const exec = promisify(execFile);
  let root: string;
  let verifier: string;
  let data: string;
  let neutralData: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "f5-protection-pixels-test-"));
    verifier = join(root, "verifier");
    const generatorSource = join(root, "generator.swift");
    const generator = join(root, "generator");
    await writeFile(
      generatorSource,
      `import AppKit
let canvas=CGContext(data:nil,width:90,height:30,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
canvas.setFillColor(CGColor(gray:0.45,alpha:1));canvas.fill(CGRect(x:0,y:0,width:90,height:30))
if !CommandLine.arguments.contains("--neutral") {
for (x,color) in [(0,CGColor(colorSpace:CGColorSpaceCreateDeviceRGB(),components:[0,0,1,1])!),(30,CGColor(red:0,green:1,blue:0,alpha:1)),(60,CGColor(gray:0.45,alpha:1))] {
  canvas.setFillColor(color);canvas.fill(CGRect(x:x,y:0,width:30,height:30))
}
}
let bytes=NSBitmapImageRep(cgImage:canvas.makeImage()!).representation(using:.png,properties:[:])!
FileHandle.standardOutput.write(Data(bytes.base64EncodedString().utf8))`,
    );
    await Promise.all([
      exec("swiftc", ["-framework", "AppKit", generatorSource, "-o", generator], {
        timeout: 30000,
      }),
      exec(
        "swiftc",
        [
          "-framework",
          "AppKit",
          resolve(import.meta.dirname, "../../native/macos/Fixtures/CaptureVerifier.swift"),
          "-o",
          verifier,
        ],
        { timeout: 30000 },
      ),
    ]);
    data = (await exec(generator)).stdout;
    neutralData = (await exec(generator, ["--neutral"])).stdout;
  }, 30000);
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });
  const rect = (x: number) => ({ x, y: 0, width: 30, height: 30 });
  const verify = (input: Record<string, unknown>) =>
    new Promise<Record<string, boolean>>((done, reject) => {
      const child = execFile(verifier, [], { timeout: 5000 }, (error, stdout) => {
        if (error) reject(error);
        else done(JSON.parse(stdout));
      });
      child.stdin!.end(
        JSON.stringify({ data, mimeType: "image/png", requireBlue: true, ...input }),
      );
    });
  it("finds both positive controls and the independently neutral secure area", async () => {
    expect(
      await verify({ blueRect: rect(0), greenRect: rect(30), secureRect: rect(60) }),
    ).toMatchObject({
      blueMarkerVisible: true,
      greenMarkerVisible: true,
      secureMasked: true,
    });
  });
  it("ignores similarly colored browser chrome outside the known marker rectangles", async () => {
    expect(await verify({ blueRect: rect(60), greenRect: rect(0) })).toMatchObject({
      blueMarkerVisible: false,
      greenMarkerVisible: false,
    });
  });
  it("finds a marker downscaled to a few pixels tall on a wide display", async () => {
    // A 400x24 pt marker on a 5120x1440 display shrinks to about 114x7 model pixels.
    const thin = (x: number) => ({ x, y: 10, width: 30, height: 7 });
    expect(await verify({ blueRect: thin(0) })).toMatchObject({ blueMarkerVisible: true });
    expect(await verify({ blueRect: thin(60) })).toMatchObject({ blueMarkerVisible: false });
  });
  it("rejects an exposed secure rectangle and off-image marker bounds", async () => {
    expect(await verify({ secureRect: rect(30) })).toMatchObject({ secureMasked: false });
    await expect(verify({ blueRect: rect(80) })).rejects.toThrow();
  });
  it("requires every pixel to be neutral for an empty-grant frame", async () => {
    expect(await verify({ neutralFrame: true })).toMatchObject({ allNeutral: false });
    expect(await verify({ neutralFrame: true, data: neutralData })).toMatchObject({
      allNeutral: true,
    });
  });
});
