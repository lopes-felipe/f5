import { beforeEach, expect, it, vi } from "vitest";
import { macPasskeyBackend } from "./PasskeyBackendMac";
import { authenticatorDataFromAttestation } from "./PasskeyAttestation";
const native = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn() }));
vi.mock("electron-webauthn", () => ({
  createCredential: native.create,
  getCredential: native.get,
}));
beforeEach(() => {
  vi.resetAllMocks();
});
const context = { origin: "https://account.example.com", nativeWindowHandle: Buffer.from([1]) };
it("pins the real origin, blocks public and private suffix RP IDs, and enforces ES256", async () => {
  const publicKey = {
    challenge: new Uint8Array([1]),
    rp: { name: "Example" },
    user: { id: new Uint8Array([2]), name: "person", displayName: "Person" },
    pubKeyCredParams: [{ type: "public-key", alg: -257 }],
  } satisfies PublicKeyCredentialCreationOptions;
  expect(await macPasskeyBackend.create(publicKey, context)).toMatchObject({
    error: "NotSupportedError",
  });
  expect(native.create).not.toHaveBeenCalled();
  const authData = Buffer.alloc(37, 1);
  const attestation = Buffer.concat([
    Buffer.from([0xa1, 0x68]),
    Buffer.from("authData"),
    Buffer.from([0x58, 37]),
    authData,
  ]);
  native.create.mockResolvedValue({
    success: true,
    data: { attestationObject: attestation.toString("base64url") },
  });
  const result = await macPasskeyBackend.create(
    { ...publicKey, pubKeyCredParams: [{ type: "public-key", alg: -7 }] },
    context,
  );
  expect(result).toMatchObject({
    success: true,
    data: { authData: authData.toString("base64url"), transports: [] },
  });
  const options = native.create.mock.lastCall?.[1];
  expect(options).toMatchObject({ currentOrigin: context.origin, topFrameOrigin: context.origin });
  expect(options.isPublicSuffix("github.io")).toBe(true);
  expect(options.isPublicSuffix("com")).toBe(true);
  expect(options.isPublicSuffix("account.example.com")).toBe(false);
  expect(options.isPublicSuffix("localhost")).toBe(false);
});
it("rejects credentials outside the requested allow list, including security-key responses", async () => {
  native.get.mockResolvedValue({ success: true, data: { credentialId: "unrequested" } });
  const request: PublicKeyCredentialRequestOptions = {
    challenge: new Uint8Array([1]),
    allowCredentials: [{ type: "public-key", id: new Uint8Array([2]) }],
  };
  expect(await macPasskeyBackend.get(request, context)).toMatchObject({ error: "NotAllowedError" });
  expect(native.get.mock.lastCall?.[0].rpId).toBe("account.example.com");
  native.get.mockResolvedValue({ success: true, data: { credentialId: "Ag" } });
  expect(await macPasskeyBackend.get(request, context)).toMatchObject({ success: true });
});
it("refuses malformed CBOR attestations", () => {
  for (const bytes of [
    [],
    [0xff],
    [0xa1, 0x68, 0x61],
    [0xa1, 0x68, ...Buffer.from("authData"), 0x59, 0xff, 0xff],
  ]) {
    expect(authenticatorDataFromAttestation(Uint8Array.from(bytes))).toBeUndefined();
  }
});
