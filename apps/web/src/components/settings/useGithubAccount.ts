import type {
  GithubCliAccount,
  GithubCliCandidates,
  GithubCliImportResult,
  GithubLoginStatus,
} from "@t3tools/contracts";
import { normalizeGithubHost } from "@t3tools/shared/github";
import { useCallback, useEffect, useRef, useState } from "react";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { readNativeApi } from "../../nativeApi";

export const GITHUB_IDENTITY_DEBOUNCE_MS = 350;
export const GITHUB_LOGIN_POLL_MS = 1500;
export const GITHUB_BROWSER_SIGN_IN_HOST = "github.com";
/** Same scopes as the browser (device-flow) sign-in requests. */
export const GITHUB_TOKEN_SCOPES = ["repo", "read:org", "notifications"] as const;

export type GithubConnection =
  | { kind: "invalid-host" }
  | { kind: "checking"; host: string }
  | { kind: "connected"; host: string; login: string }
  | { kind: "disconnected"; host: string }
  | { kind: "error"; host: string; message: string };

export type GithubAccountAction =
  | "sign-in"
  | "cancel"
  | "token"
  | "check"
  | "disconnect"
  | "cli-find"
  | "cli-import";

export const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Owns the GitHub account RPCs and state for Settings > Integrations.
 * Identity checks carry their own revision so unrelated actions (saving the Git author,
 * opening links) never discard an in-flight check.
 */
export function useGithubAccount() {
  const api = readNativeApi()?.profiles;
  const [hostInput, setHostInput] = useState("github.com");
  const host = normalizeGithubHost(hostInput);
  const [connection, setConnection] = useState<GithubConnection>({
    kind: "checking",
    host: "github.com",
  });
  const [login, setLogin] = useState<GithubLoginStatus | null>(null);
  /** Only device-flow attempts started (or found pending) by this view surface their errors. */
  const [activeHandle, setActiveHandle] = useState<string | null>(null);
  const [action, setAction] = useState<GithubAccountAction | null>(null);
  const [actionError, setActionError] = useState("");
  const identityRevision = useRef(0);

  const checkIdentity = useCallback(
    async (target: string) => {
      if (!api) return;
      const revision = ++identityRevision.current;
      setConnection({ kind: "checking", host: target });
      try {
        const result = await api.githubStatus({ host: target });
        if (revision !== identityRevision.current) return;
        setConnection(
          result.login
            ? { kind: "connected", host: target, login: result.login }
            : { kind: "disconnected", host: target },
        );
      } catch (cause) {
        if (revision !== identityRevision.current) return;
        setConnection({
          kind: "error",
          host: target,
          message: `Unable to verify this GitHub connection. ${errorMessage(cause)}`,
        });
      }
    },
    [api],
  );

  /** Sets a known account state and invalidates any in-flight identity check. */
  const settleIdentity = useCallback((next: GithubConnection) => {
    identityRevision.current++;
    setConnection(next);
  }, []);

  useEffect(() => {
    setActionError("");
    // A host change supersedes any in-flight check for the previous host.
    identityRevision.current++;
    if (!host) {
      setConnection({ kind: "invalid-host" });
      return;
    }
    setConnection({ kind: "checking", host });
    const timer = setTimeout(() => void checkIdentity(host), GITHUB_IDENTITY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [checkIdentity, host]);

  // Browser sign-in availability; retried once so a transient failure does not stick.
  useEffect(() => {
    if (!api) return;
    let active = true;
    const load = async (attempt: number): Promise<void> => {
      try {
        const result = await api.githubLoginStatus({});
        if (!active) return;
        setLogin(result);
        if (result.state === "pending" && result.handle) setActiveHandle(result.handle);
      } catch {
        if (active && attempt === 0) await load(1);
      }
    };
    void load(0);
    return () => {
      active = false;
    };
  }, [api]);

  const loginState = login?.state;
  const loginHandle = login?.handle;
  useEffect(() => {
    if (!api || loginState !== "pending") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let pending = true;
      try {
        const result = await api.githubLoginStatus(loginHandle ? { handle: loginHandle } : {});
        if (!active) return;
        setLogin(result);
        pending = result.state === "pending";
        if (result.state === "connected") {
          settleIdentity({
            kind: "connected",
            host: GITHUB_BROWSER_SIGN_IN_HOST,
            login: result.login ?? "",
          });
          setHostInput(GITHUB_BROWSER_SIGN_IN_HOST);
        }
      } catch {
        /* Retry transient transport failures only while sign-in is pending. */
      }
      if (active && pending) timer = setTimeout(() => void poll(), GITHUB_LOGIN_POLL_MS);
    };
    timer = setTimeout(() => void poll(), GITHUB_LOGIN_POLL_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, loginHandle, loginState, settleIdentity]);

  /** Runs one account action at a time; resolves `true` when it succeeded. */
  const run = useCallback(
    async (name: GithubAccountAction, operation: () => Promise<void>): Promise<boolean> => {
      setAction(name);
      setActionError("");
      try {
        await operation();
        return true;
      } catch (cause) {
        setActionError(errorMessage(cause));
        return false;
      } finally {
        setAction(null);
      }
    },
    [],
  );

  const openExternal = useCallback(async (url: string) => {
    await readNativeApi()?.shell.openExternal(url);
  }, []);

  const signIn = useCallback(
    () =>
      run("sign-in", async () => {
        if (!api || host !== GITHUB_BROWSER_SIGN_IN_HOST) return;
        const result = await api.githubLoginStart();
        setLogin(result);
        setActiveHandle(result.handle ?? null);
        if (result.state === "pending" && result.verificationUri)
          await openExternal(result.verificationUri).catch(() => {});
      }),
    [api, host, openExternal, run],
  );

  const cancelSignIn = useCallback(
    () =>
      run("cancel", async () => {
        if (!api) return;
        await api.githubLoginCancel(login?.handle ? { handle: login.handle } : {});
        setLogin(await api.githubLoginStatus({}));
      }),
    [api, login?.handle, run],
  );

  const saveToken = useCallback(
    (token: string) =>
      run("token", async () => {
        if (!api || !host || !token.trim()) return;
        const result = await api.githubSet({ host, token: token.trim() });
        settleIdentity({ kind: "connected", host, login: result.login });
        setActiveHandle(null);
      }),
    [api, host, run, settleIdentity],
  );

  const disconnect = useCallback(
    () =>
      run("disconnect", async () => {
        if (!api || !host) return;
        await api.githubRemove({ host });
        settleIdentity({ kind: "disconnected", host });
        setActiveHandle(null);
      }),
    [api, host, run, settleIdentity],
  );

  const recheck = useCallback(
    () =>
      run("check", async () => {
        if (host) await checkIdentity(host);
      }),
    [checkIdentity, host, run],
  );

  // Existing GitHub CLI login import. Discovery runs `gh auth status` (network checks on the
  // backend), so it is only loaded when the user asks for it.
  const [cliCandidates, setCliCandidates] = useState<GithubCliCandidates | null>(null);
  const [cliPanelOpen, setCliPanelOpen] = useState(false);
  const [cliImported, setCliImported] = useState<(GithubCliImportResult & { host: string }) | null>(
    null,
  );

  const findCliLogins = useCallback(
    () =>
      run("cli-find", async () => {
        if (!api) return;
        setCliPanelOpen(true);
        setCliCandidates(null);
        setCliCandidates(await api.githubCliCandidates());
      }),
    [api, run],
  );

  const closeCliLogins = useCallback(() => {
    setCliPanelOpen(false);
    setCliCandidates(null);
  }, []);

  const importCliLogin = useCallback(
    (account: Pick<GithubCliAccount, "host" | "login">) =>
      run("cli-import", async () => {
        if (!api) return;
        const result = await api.githubCliImport({ host: account.host, login: account.login });
        settleIdentity({ kind: "connected", host: account.host, login: result.login });
        setHostInput(account.host);
        setActiveHandle(null);
        setCliImported({ ...result, host: account.host });
        setCliPanelOpen(false);
        setCliCandidates(null);
      }),
    [api, run, settleIdentity],
  );

  const attempt = login && login.handle && login.handle === activeHandle ? login : null;
  return {
    api,
    hostInput,
    setHostInput,
    host,
    connection,
    /** `null` until the server reports whether browser sign-in is enabled for this install. */
    browserSignInAvailable: login ? login.available : null,
    /** Browser (device-flow) sign-in only targets github.com; Enterprise uses a token. */
    browserSignInSupportedForHost: host === GITHUB_BROWSER_SIGN_IN_HOST,
    attempt,
    signingIn: login?.state === "pending",
    action,
    busy: action !== null,
    actionError,
    signIn,
    cancelSignIn,
    saveToken,
    disconnect,
    recheck,
    openExternal,
    cliPanelOpen,
    cliCandidates,
    /** Last import for the selected host, used to warn about missing scopes. */
    cliImported: cliImported && cliImported.host === host ? cliImported : null,
    findCliLogins,
    closeCliLogins,
    importCliLogin,
  };
}

/** Draft Git author fields that follow saved settings until the user edits them. */
export function useGitAuthorDraft() {
  const saved = useSettings((settings) => ({
    name: settings.gitAuthorName ?? "",
    email: settings.gitAuthorEmail ?? "",
  }));
  const { updateSettings } = useUpdateSettings();
  const [base, setBase] = useState(saved);
  const [name, setName] = useState(saved.name);
  const [email, setEmail] = useState(saved.email);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Settings can load after mount: adopt new saved values unless the draft was edited.
  if (saved.name !== base.name || saved.email !== base.email) {
    setBase(saved);
    if (name === base.name && email === base.email) {
      setName(saved.name);
      setEmail(saved.email);
    }
  }

  const trimmed = { name: name.trim(), email: email.trim() };
  const dirty = trimmed.name !== saved.name || trimmed.email !== saved.email;
  const complete = Boolean(trimmed.name) === Boolean(trimmed.email);
  const emailValid = !trimmed.email || /^[^\s@]+@[^\s@]+$/.test(trimmed.email);
  const canSave = dirty && complete && emailValid && !saving;

  const save = async (): Promise<boolean> => {
    if (!canSave) return false;
    setSaving(true);
    setError("");
    try {
      await updateSettings({ gitAuthorName: trimmed.name, gitAuthorEmail: trimmed.email });
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setSaving(false);
    }
  };

  return {
    name,
    email,
    setName,
    setEmail,
    saved,
    dirty,
    complete,
    emailValid,
    canSave,
    saving,
    error,
    save,
  };
}
