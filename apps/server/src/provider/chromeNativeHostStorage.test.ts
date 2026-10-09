import * as NodeServices from "@effect/platform-node/NodeServices";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { ChromeNativeHostTransactions, parseNativeHostManifest } from "./chromeNativeHost";
import { makeChromeNativeHostStorage } from "./chromeNativeHostStorage";

it.each(["claude", "codex"] as const)(
  "persists %s transactions atomically outside settings and rejects identity drift",
  async (provider) => {
    const stateDir = await mkdtemp(join(tmpdir(), "f5-chrome-transactions-"));
    const manifest = JSON.stringify({
      name: "certified-test-host",
      type: "stdio",
      path: "/old-target",
      allowed_origins: [],
    });
    const current = [parseNativeHostManifest("chrome", "test-location", manifest)];
    try {
      const create = () =>
        Effect.runPromise(
          makeChromeNativeHostStorage({
            stateDir,
            inspect: async () => current,
            restoreRegistration: async () => {},
          }).pipe(Effect.provide(NodeServices.layer)),
        );
      const storage = await create();
      const transactions = new ChromeNativeHostTransactions(storage);
      const approved = await transactions.approve({
        provider,
        profileId: "test-profile",
        targetPath: "/new-target",
        observed: current,
      });
      const restarted = await create();
      expect(await restarted.loadTransaction(provider, approved.id)).toEqual(approved);
      expect(await restarted.listTransactions(provider)).toEqual([approved]);
      await expect(restarted.loadTransaction(provider, "../../outside")).rejects.toThrow();
      const file = join(stateDir, `${provider}-chrome`, "transactions", `${approved.id}.json`);
      const bytes = await readFile(file, "utf8");
      await writeFile(
        file,
        JSON.stringify({
          ...JSON.parse(bytes),
          profileId: "test-profile",
          id: "00000000-0000-0000-0000-000000000000",
        }),
      );
      await expect(restarted.loadTransaction(provider, approved.id)).rejects.toThrow(
        "identity mismatch",
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  },
);
