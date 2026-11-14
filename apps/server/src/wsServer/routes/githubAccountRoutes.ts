import { WS_METHODS } from "@t3tools/contracts";
import { Effect } from "effect";

import type { GithubCliImport } from "../../git/GithubCliImport.ts";
import type { GithubDeviceLogin } from "../../git/GithubDeviceLogin.ts";
import type { ProfileGithubAccount } from "../../git/ProfileGithubAccount.ts";
import { routePromise, type RouteTable } from "./routeTable.ts";

type GithubAccountMethod =
  | typeof WS_METHODS.githubLoginStart
  | typeof WS_METHODS.githubLoginStatus
  | typeof WS_METHODS.githubLoginCancel
  | typeof WS_METHODS.githubAccountSet
  | typeof WS_METHODS.githubAccountRemove
  | typeof WS_METHODS.githubAccountStatus
  | typeof WS_METHODS.githubAccountCliCandidates
  | typeof WS_METHODS.githubAccountCliImport;

export interface GithubAccountRouteDependencies {
  readonly login: Pick<GithubDeviceLogin, "start" | "status" | "cancel">;
  readonly account: Pick<ProfileGithubAccount, "set" | "remove" | "status">;
  readonly cliImport: Pick<GithubCliImport, "candidates" | "import">;
}

/** The profile's GitHub account: browser sign-in, a pasted token, or an import from `gh`. */
export const githubAccountRoutes = ({
  login,
  account,
  cliImport,
}: GithubAccountRouteDependencies): RouteTable<GithubAccountMethod> => {
  // Browser sign-in is github.com-only; any other change to that host's account supersedes it.
  const supersedeBrowserLogin = (host: string) => {
    if (host === "github.com") login.cancel();
  };
  return {
    [WS_METHODS.githubLoginStart]: () => routePromise(() => login.start()),
    [WS_METHODS.githubLoginStatus]: ({ handle }) => Effect.sync(() => login.status(handle)),
    [WS_METHODS.githubLoginCancel]: ({ handle }) => Effect.sync(() => login.cancel(handle)),
    [WS_METHODS.githubAccountSet]: ({ host, token }) =>
      Effect.suspend(() => {
        supersedeBrowserLogin(host);
        return routePromise(() => account.set(host, token));
      }),
    [WS_METHODS.githubAccountRemove]: ({ host }) =>
      Effect.suspend(() => {
        supersedeBrowserLogin(host);
        return routePromise(() => account.remove(host));
      }),
    [WS_METHODS.githubAccountStatus]: ({ host }) => routePromise(() => account.status(host)),
    [WS_METHODS.githubAccountCliCandidates]: () => routePromise(() => cliImport.candidates()),
    [WS_METHODS.githubAccountCliImport]: ({ host, login: cliLogin }) =>
      Effect.suspend(() => {
        supersedeBrowserLogin(host);
        return routePromise(() => cliImport.import({ host, login: cliLogin }));
      }),
  };
};
