import { describe, expect, it } from "vitest";
import {
  buildLimaInstanceConfig,
  guestImageCacheDir,
  LimaConfigError,
  limaHomeFor,
  longestLimaSocketPath,
  serializeLimaInstanceConfig,
} from "./limaInstanceConfig";

const imageSha256 = "a".repeat(64);
const profileId = "0123456789abcdef0123456789abcdef";

describe("buildLimaInstanceConfig", () => {
  it("emits a VZ instance with nothing shared or forwarded by default", () => {
    const config = buildLimaInstanceConfig({ imagePath: "/state/vm/images/a.qcow2", imageSha256 });
    expect(config).toMatchObject({
      vmType: "vz",
      arch: "aarch64",
      cpus: 2,
      memory: "4GiB",
      disk: "8GiB",
      mountType: "virtiofs",
      mounts: [],
      images: [{ location: "/state/vm/images/a.qcow2", digest: `sha256:${imageSha256}` }],
      additionalDisks: [{ name: "f5-data", format: true, fsType: "ext4" }],
      ssh: { loadDotSSHPubKeys: false, forwardAgent: false, forwardX11: false },
      containerd: { system: false, user: false },
      propagateProxyEnv: false,
    });
    expect(config.portForwards).toEqual([
      { guestIP: "0.0.0.0", guestPortRange: [1, 65535], proto: "any", ignore: true },
      { guestIP: "127.0.0.1", guestPortRange: [1, 65535], proto: "any", ignore: true },
    ]);
    expect(config).not.toHaveProperty("provision");
    expect(config).not.toHaveProperty("probes");
  });

  it("mounts exports at their own canonical paths", () => {
    const config = buildLimaInstanceConfig({
      imagePath: "/i.qcow2",
      imageSha256,
      mounts: [{ location: "/Users/me/vm-work", writable: true }],
    });
    expect(config.mounts).toEqual([
      { location: "/Users/me/vm-work", mountPoint: "/Users/me/vm-work", writable: true },
    ]);
  });

  it.each([
    [{ imagePath: "relative.qcow2", imageSha256 }],
    [{ imagePath: "/a/../b.qcow2", imageSha256 }],
    [{ imagePath: "/i.qcow2", imageSha256: "abc" }],
    [{ imagePath: "/i.qcow2", imageSha256, cpus: 0 }],
    [{ imagePath: "/i.qcow2", imageSha256, memoryGiB: 2.5 }],
    [{ imagePath: "/i.qcow2", imageSha256, mounts: [{ location: "/", writable: true }] }],
    [{ imagePath: "/i.qcow2", imageSha256, mounts: [{ location: "/a/./b", writable: true }] }],
  ])("refuses invalid input %#", (input) => {
    expect(() => buildLimaInstanceConfig(input)).toThrow(LimaConfigError);
  });

  it("serializes as JSON so values can't change the document's structure", () => {
    const text = serializeLimaInstanceConfig(
      buildLimaInstanceConfig({ imagePath: "/x\nprovision: [evil]", imageSha256 }),
    );
    const parsed = JSON.parse(text);
    expect(parsed.images[0].location).toBe("/x\nprovision: [evil]");
    expect(parsed).not.toHaveProperty("provision");
  });
});

describe("limaHomeFor", () => {
  it("places LIMA_HOME under the installation state with a short profile prefix", () => {
    expect(limaHomeFor("/Users/me/.f5/userdata", profileId)).toBe(
      "/Users/me/.f5/userdata/vm/0123456789abcdef",
    );
    expect(guestImageCacheDir("/Users/me/.f5/userdata")).toBe("/Users/me/.f5/userdata/vm/images");
  });

  it("refuses a state directory too long for Lima's sockets", () => {
    const long = "/Users/" + "x".repeat(80);
    expect(Buffer.byteLength(longestLimaSocketPath(long + "/vm/0123456789abcdef"))).toBeGreaterThan(
      103,
    );
    expect(() => limaHomeFor(long, profileId)).toThrow(/too long/);
  });

  it("refuses a malformed profile id", () => {
    expect(() => limaHomeFor("/s", "../../etc")).toThrow(LimaConfigError);
  });
});
