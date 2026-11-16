import { expect, it, vi } from "vitest";
import { pollActivity } from "./demand";
it("counts valid authenticated activity and treats failures and malformed responses as idle", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ busyThreadCount: 2 }))
    .mockResolvedValueOnce(Response.json({ busyThreadCount: -1 }))
    .mockResolvedValueOnce(Response.json({ state: "starting" }, { status: 503 }))
    .mockRejectedValueOnce(new Error("timeout"))
    .mockResolvedValueOnce(Response.json({ busyThreadCount: 1.5 }));
  const count = await pollActivity(
    Array.from({ length: 5 }, () => ({ origin: "http://localhost:1", token: "token" })),
    request,
  );
  expect(count).toBe(2);
  expect(request).toHaveBeenCalledWith(
    "http://localhost:1/api/desktop/activity",
    expect.objectContaining({
      headers: { Authorization: "Bearer token" },
      redirect: "error",
    }),
  );
});
