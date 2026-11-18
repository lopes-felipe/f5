import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type {
  CodexConfigurationAction,
  CodexConfigurationResult,
  CodexNativeProvider,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { ensureNativeApi } from "../../nativeApi";
import { Button } from "../ui/button";

function externalUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function ProviderEditor({
  provider,
  save,
  newProvider = "customGateway",
}: {
  provider?: CodexNativeProvider;
  newProvider?: "customGateway" | "gcp" | "amazon-bedrock" | "amazon-bedrock-runtime";
  save: (action: CodexConfigurationAction) => Promise<void>;
}) {
  const settings =
    provider?.settings ??
    (newProvider === "gcp"
      ? { type: "gcp" as const, projectId: null, location: null, credentialFile: null }
      : newProvider === "customGateway"
        ? undefined
        : { type: "bedrock" as const, profile: null, region: null });
  const initial: Record<string, string> =
    settings?.type === "bedrock"
      ? { profile: settings.profile ?? "", region: settings.region ?? "" }
      : settings?.type === "gcp"
        ? {
            projectId: settings.projectId ?? "",
            location: settings.location ?? "",
            credentialFile: settings.credentialFile ?? "",
          }
        : {
            name: provider?.name ?? "",
            baseUrl: provider?.baseUrl ?? "",
            ...(settings?.type === "customGateway" && settings.auth.mode === "externallyConfigured"
              ? {}
              : {
                  envKey:
                    settings?.type === "customGateway" &&
                    settings.auth.mode === "environmentVariable"
                      ? settings.auth.envKey
                      : "",
                }),
          };
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (settings?.type === "openai") return null;
  const changed = Object.keys(initial).filter((key) => draft[key] !== initial[key]);
  return (
    <form
      className="space-y-2 rounded border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        const fields = Object.fromEntries(
          (provider ? changed : Object.keys(draft)).map((key) => [key, draft[key] || null]),
        );
        const patch = {
          type: settings?.type ?? "customGateway",
          ...(provider
            ? { providerId: provider.id }
            : newProvider !== "customGateway"
              ? { providerId: newProvider }
              : {}),
          ...fields,
        };
        setBusy(true);
        setError(undefined);
        void save({
          type: "write",
          settings: patch as Extract<CodexConfigurationAction, { type: "write" }>["settings"],
        })
          .catch((cause) => setError(String(cause)))
          .finally(() => setBusy(false));
      }}
    >
      <p className="font-medium">
        {provider?.name ??
          (newProvider === "customGateway" ? "New custom gateway" : "Configure " + newProvider)}
      </p>
      {Object.keys(initial).map((key) => (
        <label className="block" key={key}>
          <span>
            {
              (
                {
                  name: "Name",
                  baseUrl: "Endpoint URL",
                  envKey: "API key environment variable",
                  profile: "AWS profile",
                  region: "AWS region",
                  projectId: "Google Cloud project",
                  location: "Google Cloud location",
                  credentialFile: "Credential file on server",
                } as Record<string, string>
              )[key]
            }
          </span>
          <input
            className="mt-1 block w-full rounded border bg-background px-2 py-1"
            required={key === "name" || (!provider && key === "baseUrl")}
            value={draft[key]}
            disabled={busy || provider?.canEdit === false}
            aria-label={(provider?.name ?? "New gateway") + " " + key}
            onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
          />
        </label>
      ))}
      {settings?.type === "customGateway" && settings.auth.mode === "externallyConfigured" && (
        <p>Authentication is configured externally and will be preserved.</p>
      )}
      <Button
        size="xs"
        type="submit"
        disabled={busy || provider?.canEdit === false || (!!provider && changed.length === 0)}
      >
        {provider
          ? "Save provider"
          : newProvider === "customGateway"
            ? "Create gateway"
            : "Save cloud provider"}
      </Button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

export function CodexConfigurationSection({
  instanceId,
  accountIdentity,
  selectedProvider,
  onSelectProvider,
}: {
  instanceId: ProviderInstanceId;
  accountIdentity: string;
  selectedProvider?: string | undefined;
  onSelectProvider: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [newProvider, setNewProvider] = useState<
    "customGateway" | "gcp" | "amazon-bedrock" | "amazon-bedrock-runtime"
  >("customGateway");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [gateway, setGateway] = useState<CodexConfigurationResult>();
  const request = (action: CodexConfigurationAction) => {
    const call = ensureNativeApi().server.codexConfiguration;
    if (!call) return Promise.reject(new Error("Update the F5 server to configure Codex."));
    return call({ instanceId, action });
  };
  const query = useQuery({
    queryKey: ["codex-configuration", instanceId, accountIdentity],
    queryFn: () => request({ type: "read" }),
    enabled: expanded,
    staleTime: 0,
  });
  const gatewayId = gateway?.gateway?.providerId;
  const loginQuery = useQuery({
    queryKey: ["codex-gateway", instanceId, accountIdentity, gatewayId],
    queryFn: () => request({ type: "gatewayRead", providerId: gatewayId! }),
    enabled: expanded && !!gatewayId,
    refetchInterval: (query) => (query.state.data?.login?.status === "started" ? 1000 : false),
    staleTime: 0,
  });
  const login =
    loginQuery.data?.login?.loginId === gateway?.login?.loginId
      ? loginQuery.data?.login
      : gateway?.login;
  const act = async (action: CodexConfigurationAction) => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await request(action);
      if (action.type.startsWith("gateway")) {
        setGateway(result);
        await loginQuery.refetch();
      } else {
        if (action.type === "write") setNewProvider("customGateway");
        await query.refetch();
        await ensureNativeApi().server.refreshProviders({ instanceId });
      }
    } catch (cause) {
      setError(String(cause));
      throw cause;
    } finally {
      setBusy(false);
    }
  };
  const run = (action: CodexConfigurationAction) => {
    void act(action).catch(() => undefined);
  };
  const notice = query.data?.securityNotice;
  return (
    <section className="rounded-lg border p-3 text-xs space-y-3">
      <Button
        size="xs"
        variant="outline"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        Codex model providers
      </Button>
      {expanded && (
        <>
          <p>
            Configure Codex gateways, cloud providers, and experimental media. Existing
            conversations retain their native provider.
          </p>
          {query.isPending && <p>Loading Codex configuration…</p>}
          {(error || query.error) && <p role="alert">{error ?? String(query.error)}</p>}
          {loginQuery.error && <p role="alert">{String(loginQuery.error)}</p>}
          {query.data?.providers && (
            <>
              <label className="block">
                Provider for new conversations
                <select
                  className="ml-2 rounded border bg-background p-1"
                  value={selectedProvider ?? ""}
                  disabled={busy}
                  onChange={(event) => onSelectProvider(event.target.value)}
                >
                  <option value="">Codex default ({query.data.providers.defaultProviderId})</option>
                  {query.data.providers.data.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                </select>
              </label>
              {query.data.providers.data.map((provider) => (
                <div className="space-y-2" key={provider.id}>
                  <ProviderEditor provider={provider} save={act} key={JSON.stringify(provider)} />
                  <div className="flex gap-2">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy || !query.data?.providers?.canChangeDefault}
                      onClick={() => run({ type: "setDefault", providerId: provider.id })}
                    >
                      Make {provider.name} Codex default
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => run({ type: "gatewayRead", providerId: provider.id })}
                    >
                      Check {provider.name} sign-in
                    </Button>
                  </div>
                </div>
              ))}
              <label className="block">
                Add native provider
                <select
                  className="ml-2 rounded border bg-background p-1"
                  value={newProvider}
                  onChange={(event) => setNewProvider(event.target.value as typeof newProvider)}
                >
                  <option value="customGateway">Custom gateway</option>
                  {(["gcp", "amazon-bedrock", "amazon-bedrock-runtime"] as const)
                    .filter(
                      (id) => !query.data?.providers?.data.some((provider) => provider.id === id),
                    )
                    .map((id) => (
                      <option key={id} value={id}>
                        {id === "gcp"
                          ? "Google Vertex AI"
                          : id === "amazon-bedrock"
                            ? "Amazon Bedrock API key"
                            : "Amazon Bedrock AWS credentials"}
                      </option>
                    ))}
                </select>
              </label>
              <ProviderEditor key={newProvider} newProvider={newProvider} save={act} />
            </>
          )}
          {gateway?.gateway && (
            <div className="space-y-2">
              <p>
                {gateway.gateway.providerName}:{" "}
                {loginQuery.data?.gateway?.status ??
                  gateway.gateway.status ??
                  "No gateway OAuth required"}
              </p>
              {gateway.gateway.required && (
                <>
                  <Button
                    size="xs"
                    disabled={busy}
                    onClick={() =>
                      run({
                        type: "gatewayLogin",
                        providerId: gateway.gateway!.providerId,
                        deviceAuth: false,
                      })
                    }
                  >
                    Sign in to gateway
                  </Button>
                  {gateway.gateway.supportsDeviceAuth && (
                    <Button
                      size="xs"
                      disabled={busy}
                      onClick={() =>
                        run({
                          type: "gatewayLogin",
                          providerId: gateway.gateway!.providerId,
                          deviceAuth: true,
                        })
                      }
                    >
                      Use device code
                    </Button>
                  )}
                </>
              )}
              {login && (
                <>
                  {externalUrl(login.authUrl ?? login.verificationUrl) && (
                    <a
                      className="underline"
                      target="_blank"
                      rel="noreferrer"
                      href={externalUrl(login.authUrl ?? login.verificationUrl)}
                    >
                      Open gateway sign-in
                    </a>
                  )}
                  {login.userCode && (
                    <p>
                      Device code: <code>{login.userCode}</code>
                    </p>
                  )}
                  <p>
                    {login.status}
                    {login.error ? ": " + login.error : ""}
                  </p>
                  {login.status === "started" && (
                    <Button
                      size="xs"
                      disabled={busy}
                      onClick={() => run({ type: "gatewayCancel", loginId: login.loginId })}
                    >
                      Cancel gateway login
                    </Button>
                  )}
                </>
              )}
            </div>
          )}
          {query.data?.features && (
            <div className="space-y-2">
              {(["audio", "animation"] as const).map((feature) => (
                <label key={feature} className="block">
                  <input
                    type="checkbox"
                    className="mr-2"
                    checked={query.data!.features![feature]}
                    disabled={busy}
                    onChange={(event) =>
                      run({ type: "setFeature", feature, enabled: event.target.checked })
                    }
                  />
                  {feature === "audio"
                    ? "Audio attachments (experimental; requires an audio-capable model)"
                    : "Animated image generation (experimental)"}
                </label>
              ))}
            </div>
          )}
          {notice && (
            <div className="rounded border p-2">
              <p>{notice.title}</p>
              <p>{notice.description}</p>
              {externalUrl(notice.action.url) && (
                <a
                  href={externalUrl(notice.action.url)}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  {notice.action.label}
                </a>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
