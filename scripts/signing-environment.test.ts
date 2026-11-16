import { expect, it } from "vitest";
import { withoutSigningCredentials } from "./lib/signing-environment.ts";
it("strips both platforms' signing credentials without changing the parent environment", () => {
  const env = {
    PATH: "/bin",
    CSC_LINK: "certificate",
    APPLE_API_KEY: "key path",
    AZURE_CLIENT_SECRET: "secret",
    HOME: "/home/f5",
  };
  expect(withoutSigningCredentials(env)).toEqual({ PATH: "/bin", HOME: "/home/f5" });
  expect(env.CSC_LINK).toBe("certificate");
});
