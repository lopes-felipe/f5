import * as Path from "node:path";
import { ServerConfig, type ServerConfigShape } from "../../config";
import { fallbackDefaultProfile } from "../../profiles/ProfileRegistryStore";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterEach, expect, vi } from "vitest";

vi.mock("../../processRunner", () => ({
  runProcess: vi.fn(),
}));

vi.mock("../../outboundHttp.ts", async (importOriginal) =>
  (await import("../../testUtils/undiciFetchThroughGlobal.ts")).undiciFetchThroughGlobal(
    importOriginal,
  ),
);

import { runProcess } from "../../processRunner";
import { GitHubCli } from "../Services/GitHubCli.ts";
import * as ProfileGithubAccount from "../ProfileGithubAccount";
import { GitHubCredentialScope } from "../githubApi";
import { GitHubCliLive } from "./GitHubCli.ts";

const mockedRunProcess = vi.mocked(runProcess);

afterEach(() => {
  vi.restoreAllMocks();
  mockedRunProcess.mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.effect("Default never falls back to the host gh login or token", () =>
  Effect.gen(function* () {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_CONFIG_DIR", "/host-gh");
    mockedRunProcess.mockImplementation(async (_file, args) => ({
      stdout:
        args[0] === "auth"
          ? "legacy-token"
          : 'HTTP/2.0 200 Response\r\nContent-Type: application/json\r\n\r\n{"id":123,"login":"existing-user"}',
      stderr: "",
      code: 0,
      signal: null,
      timedOut: false,
    }));
    const gh = yield* GitHubCli;
    const error = yield* gh
      .getCredentialContext({ cwd: process.cwd(), host: "github.com" })
      .pipe(Effect.flip);
    expect(error.kind).toBe("unauthenticated");
    expect(error.detail).toContain("Connect it in Settings > Integrations");
    expect(mockedRunProcess).not.toHaveBeenCalled();
  }).pipe(
    Effect.provide(
      GitHubCliLive.pipe(
        Layer.provide(
          Layer.succeed(ServerConfig, {
            stateDir: process.cwd(),
            profile: fallbackDefaultProfile(process.cwd()),
          } as unknown as ServerConfigShape),
        ),
      ),
    ),
  ),
);

it.effect("captures only the saved profile token for Default and other profiles", () =>
  Effect.gen(function* () {
    vi.stubEnv("GH_TOKEN", "workstation-token");
    const { ServerSecretStore } = yield* Effect.promise(
      () => import("../../auth/Services/ServerSecretStore"),
    );
    const http = vi.fn<(...args: Parameters<typeof fetch>) => Promise<Response>>(
      async (_url, options) => {
        const personal =
          new Headers(options?.headers).get("authorization") === "Bearer personal-token";
        return new Response(
          JSON.stringify({ id: personal ? 1 : 2, login: personal ? "personal" : "work" }),
        );
      },
    );
    vi.stubGlobal("fetch", http);
    for (const [name, isDefault] of [
      ["personal", true],
      ["work", false],
    ] as const) {
      const stateDir = Path.resolve("test-github-profile", name);
      const identity = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getCredentialContext({ cwd: process.cwd(), host: "github.com" });
      }).pipe(
        Effect.provide(
          GitHubCliLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ServerConfig, {
                  stateDir,
                  profile: { ...fallbackDefaultProfile(stateDir), isDefault },
                } as unknown as ServerConfigShape),
                Layer.succeed(ServerSecretStore, {
                  get: () => Effect.succeed(new TextEncoder().encode(`${name}-token`)),
                  set: () => Effect.void,
                  remove: () => Effect.void,
                  list: () => Effect.succeed([]),
                  getOrCreateRandom: () => Effect.die("unused"),
                }),
              ),
            ),
          ),
        ),
      );
      expect(identity.login).toBe(name);
      expect(new Headers(http.mock.lastCall?.[1]?.headers).get("authorization")).toBe(
        `Bearer ${name}-token`,
      );
      expect(mockedRunProcess).not.toHaveBeenCalled();
    }
    expect(mockedRunProcess.mock.calls.every(([, args]) => args[0] !== "auth")).toBe(true);
  }),
);

it.effect("routes captured Enterprise search and repository commands with ServerConfig", () =>
  Effect.gen(function* () {
    const { ServerSecretStore } = yield* Effect.promise(
      () => import("../../auth/Services/ServerSecretStore"),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn<(...args: Parameters<typeof fetch>) => Promise<Response>>(
        async () => new Response(JSON.stringify({ id: 42, login: "enterprise-user" })),
      ),
    );
    mockedRunProcess.mockImplementation(async (_file, args) => ({
      stdout:
        args[0] === "api"
          ? 'HTTP/2.0 200 Response\r\nContent-Type: application/json\r\n\r\n{"id":42,"login":"enterprise-user"}'
          : "[]",
      stderr: "",
      code: 0,
      signal: null,
      timedOut: false,
    }));
    vi.stubEnv("GH_HOST", "github.com");
    vi.stubEnv("GH_REPO", "wrong/repository");
    const stateDir = Path.resolve("test-github-enterprise");
    yield* Effect.gen(function* () {
      const gh = yield* GitHubCli;
      const context = yield* gh.getCredentialContext({
        cwd: process.cwd(),
        host: "git.example.com",
      });
      for (const args of [
        ["search", "prs", "--author", "@me"],
        ["pr", "view", "1", "--repo", "owner/repo"],
      ]) {
        yield* gh
          .execute({ cwd: process.cwd(), args })
          .pipe(Effect.provideService(GitHubCredentialScope, context));
        const env = mockedRunProcess.mock.lastCall?.[2]?.env;
        expect(env?.GH_HOST).toBe("git.example.com");
        expect(env?.GH_REPO).toBeUndefined();
        expect(env?.GH_ENTERPRISE_TOKEN).toBe("enterprise-token");
        expect(env?.GH_CONFIG_DIR).toBe(Path.join(stateDir, "github"));
      }
    }).pipe(
      Effect.provide(
        GitHubCliLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ServerConfig, {
                stateDir,
                profile: fallbackDefaultProfile(stateDir),
              } as unknown as ServerConfigShape),
              Layer.succeed(ServerSecretStore, {
                get: () => Effect.succeed(new TextEncoder().encode("enterprise-token")),
                set: () => Effect.void,
                remove: () => Effect.void,
                list: () => Effect.succeed([]),
                getOrCreateRandom: () => Effect.die("unused"),
              }),
            ),
          ),
        ),
      ),
    );
  }),
);

it.effect("preserves reconnect guidance and skips gh when reconciliation failed", () =>
  Effect.gen(function* () {
    vi.spyOn(ProfileGithubAccount, "assertGithubCredentialsAvailable").mockImplementation(() => {
      throw new Error("GitHub credentials are unavailable. Reconnect in Settings > Integrations.");
    });
    const gh = yield* GitHubCli;
    const error = yield* gh
      .execute({ cwd: process.cwd(), args: ["api", "user"] })
      .pipe(Effect.flip);
    expect(error.kind).toBe("unauthenticated");
    expect(error.detail).toContain("Settings > Integrations > GitHub");
    expect(mockedRunProcess).not.toHaveBeenCalled();
  }).pipe(
    Effect.provide(
      GitHubCliLive.pipe(
        Layer.provide(
          Layer.succeed(ServerConfig, {
            stateDir: process.cwd(),
            profile: fallbackDefaultProfile(process.cwd()),
          } as unknown as ServerConfigShape),
        ),
      ),
    ),
  ),
);

it.effect(
  "never treats the disconnected CLI placeholder as an API token and caches a miss for ten seconds",
  () =>
    Effect.gen(function* () {
      vi.stubEnv("GH_TOKEN", "");
      vi.stubEnv("GITHUB_TOKEN", "");
      let now = 1_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      mockedRunProcess.mockResolvedValue({
        stdout: "f5-profile-not-connected\n",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });
      const fetcher = vi.fn<(...args: Parameters<typeof fetch>) => Promise<Response>>(async () =>
        Response.json({ id: 123, login: "alice" }),
      );
      vi.stubGlobal("fetch", fetcher);
      const { makeGitHubCli } = yield* Effect.promise(() => import("./GitHubCli.ts"));
      const gh = yield* makeGitHubCli();
      for (let attempt = 0; attempt < 2; attempt++)
        expect(
          (yield* gh.getCredentialContext({ cwd: "/repo", host: "github.com" }).pipe(Effect.flip))
            .kind,
        ).toBe("unauthenticated");
      expect(mockedRunProcess).toHaveBeenCalledTimes(1);
      expect(fetcher).not.toHaveBeenCalled();
      now += 10_001;
      mockedRunProcess.mockResolvedValue({
        stdout: "token\n",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });
      expect((yield* gh.getCredentialContext({ cwd: "/repo", host: "github.com" })).login).toBe(
        "alice",
      );
      now += 299_999;
      yield* gh.getCredentialContext({ cwd: "/repo", host: "github.com" });
      expect(mockedRunProcess).toHaveBeenCalledTimes(2);
      now += 2;
      yield* gh.getCredentialContext({ cwd: "/repo", host: "github.com" });
      expect(mockedRunProcess).toHaveBeenCalledTimes(3);
    }),
);

it.effect.each(["gh", "http"] as const)(
  "sends captured requests through the %s transport the setting names",
  (githubTransport) =>
    Effect.gen(function* () {
      const { ServerSettingsService } = yield* Effect.promise(() => import("../../serverSettings"));
      const { DEFAULT_SERVER_SETTINGS } = yield* Effect.promise(() => import("@t3tools/contracts"));
      const settings = { ...DEFAULT_SERVER_SETTINGS, githubTransport };
      mockedRunProcess.mockResolvedValue({
        stdout:
          'HTTP/2.0 200 Response\r\nContent-Type: application/json\r\n\r\n{"id":7,"login":"via-gh"}',
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });
      const fetcher = vi.fn<(...args: Parameters<typeof fetch>) => Promise<Response>>(async () =>
        Response.json({ id: 7, login: "via-http" }),
      );
      vi.stubGlobal("fetch", fetcher);
      const { makeGitHubCli } = yield* Effect.promise(() => import("./GitHubCli.ts"));
      const gh = yield* makeGitHubCli({ resolveToken: () => Effect.succeed("token") }).pipe(
        Effect.provideService(
          ServerSettingsService,
          ServerSettingsService.of({
            getSettings: Effect.succeed(settings),
          } as unknown as typeof ServerSettingsService.Service),
        ),
      );

      const context = yield* gh.getCredentialContext({ cwd: "/repo", host: "github.com" });

      expect(context.login).toBe(githubTransport === "gh" ? "via-gh" : "via-http");
      expect(
        mockedRunProcess.mock.calls.some(([file, args]) => file === "gh" && args[0] === "api"),
      ).toBe(githubTransport === "gh");
      expect(fetcher).toHaveBeenCalledTimes(githubTransport === "gh" ? 0 : 1);
    }),
);
