import type { GithubLoginStatus } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { readNativeApi } from "../../nativeApi";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
export function GithubAccountPanel() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const [host, setHost] = useState("github.com");
  const [token, setToken] = useState("");
  const [identity, setIdentity] = useState("");
  const [error, setError] = useState("");
  const [name, setName] = useState(settings.gitAuthorName ?? "");
  const [email, setEmail] = useState(settings.gitAuthorEmail ?? "");
  const [login, setLogin] = useState<GithubLoginStatus>({ available: false, state: "idle" });
  const [pending, setPending] = useState(false);
  const identityRevision = useRef(0);
  const run = async (operation: () => Promise<unknown>) => {
    identityRevision.current++;
    setPending(true);
    setError("");
    try {
      await operation();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  };
  const api = readNativeApi()?.profiles;
  useEffect(() => {
    setError("");
    setIdentity("");
    if (!api || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes("..")) return;
    let active = true;
    const revision = ++identityRevision.current;
    const timer = setTimeout(() => {
      if (revision !== identityRevision.current) return;
      void api
        .githubStatus({ host })
        .then((result) => {
          if (active && revision === identityRevision.current)
            setIdentity(result.login ?? "Not connected");
        })
        .catch(() => {
          if (active && revision === identityRevision.current)
            setError("Unable to verify this GitHub connection. Check your network or reconnect.");
        });
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, host]);
  useEffect(() => {
    if (!api) return;
    let active = true;
    void api
      .githubLoginStatus({})
      .then((result) => {
        if (active) setLogin(result);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [api]);
  useEffect(() => {
    if (!api || login.state !== "pending") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let pending = true;
      try {
        const result = await api.githubLoginStatus(login.handle ? { handle: login.handle } : {});
        if (!active) return;
        setLogin(result);
        pending = result.state === "pending";
        if (result.state === "connected" && host === "github.com")
          setIdentity(result.login ?? "Connected");
      } catch {
        /* Retry transient transport failures only during an active sign-in. */
      }
      if (active && pending)
        timer = setTimeout(() => {
          void poll();
        }, 1500);
    };
    timer = setTimeout(() => {
      void poll();
    }, 1500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, host, login.state, login.handle]);
  if (!api) return null;
  return (
    <section
      className="space-y-3 rounded border p-4"
      data-settings-search-target="integrations.github"
    >
      <h3 className="font-medium">GitHub account and Git author</h3>
      <p className="text-sm text-muted-foreground">
        This profile’s connection is used by GitHub features, agents, and terminal gh commands.
        Credentials are stored in private files in this profile. Verification sends credentials only
        to the selected host.
      </p>
      <p className="text-sm text-muted-foreground">
        Upgrading from workstation GitHub authentication? Connect once here, including in Default.
        F5 does not import your workstation login, CLI aliases, or Git protocol preferences.
      </p>
      <Input
        aria-label="GitHub or GitHub Enterprise hostname"
        disabled={pending || login.state === "pending"}
        value={host}
        onChange={(event) => setHost(event.target.value.toLowerCase())}
      />
      {host === "github.com" && (
        <div className="space-y-2">
          <Button
            disabled={pending || !login.available || login.state === "pending"}
            onClick={() =>
              void run(async () => {
                const result = await api.githubLoginStart();
                setLogin(result);
                if (result.verificationUri)
                  await readNativeApi()?.shell.openExternal(result.verificationUri);
              })
            }
          >
            {identity && identity !== "Not connected" ? "Reconnect" : "Sign in with GitHub"}
          </Button>
          {!login.available && (
            <p className="text-sm text-muted-foreground">
              Browser sign-in is not configured for this installation. Use a token below.
            </p>
          )}
          {login.state === "pending" && (
            <div role="status" className="space-y-2">
              <p>
                Enter code <strong className="font-mono select-all">{login.userCode}</strong> on
                GitHub. Choose the account for this profile.
              </p>
              {login.verificationUri && (
                <Button
                  variant="outline"
                  onClick={() =>
                    void run(async () => {
                      await readNativeApi()?.shell.openExternal(login.verificationUri!);
                    })
                  }
                >
                  Open GitHub
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() =>
                  void run(async () => {
                    await api.githubLoginCancel(login.handle ? { handle: login.handle } : {});
                    setLogin(await api.githubLoginStatus({}));
                  })
                }
              >
                Cancel sign-in
              </Button>
            </div>
          )}
          {login.error && <p role="alert">{login.error}</p>}
        </div>
      )}
      <p className="text-sm text-muted-foreground">Or connect using a personal access token:</p>
      <Input
        aria-label="GitHub token"
        type="password"
        autoComplete="off"
        value={token}
        onChange={(event) => setToken(event.target.value)}
      />
      <div className="flex gap-2">
        <Button
          disabled={pending || !token}
          onClick={() =>
            void run(async () => {
              setIdentity((await api.githubSet({ host, token })).login);
              setToken("");
            })
          }
        >
          Verify and save token
        </Button>
        <Button
          disabled={pending}
          onClick={() =>
            void run(async () =>
              setIdentity((await api.githubStatus({ host })).login ?? "Not connected"),
            )
          }
        >
          Check account
        </Button>
        <Button
          disabled={pending}
          onClick={() =>
            void run(async () => {
              await api.githubRemove({ host });
              setIdentity("Not connected");
            })
          }
        >
          Disconnect
        </Button>
      </div>
      {identity && (
        <p role="status">
          {host}: {identity}
        </p>
      )}
      <Input
        aria-label="Git author name"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <Input
        aria-label="Git author email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <Button
        disabled={pending}
        onClick={() =>
          void run(() => update.updateSettings({ gitAuthorName: name, gitAuthorEmail: email }))
        }
      >
        Save Git author
      </Button>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
