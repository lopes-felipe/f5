import { useState } from "react";
import { ensureNativeApi } from "../../nativeApi";
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
  const [pending, setPending] = useState(false);
  const run = async (operation: () => Promise<unknown>) => {
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
  const api = ensureNativeApi().profiles;
  if (!api) return null;
  return (
    <section className="space-y-3 rounded border p-4">
      <h3 className="font-medium">GitHub account and Git author</h3>
      <p className="text-sm text-muted-foreground">
        Credentials are saved only in this profile. Shell tokens and gh logins are not used.
      </p>
      <Input
        aria-label="GitHub hostname"
        value={host}
        onChange={(event) => setHost(event.target.value)}
      />
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
          Remove token
        </Button>
      </div>
      {identity && <p>{identity}</p>}
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
