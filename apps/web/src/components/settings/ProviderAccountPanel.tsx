import { ChevronDownIcon, CopyIcon, ExternalLinkIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ProfileSummary, ProviderInstanceId } from "@t3tools/contracts";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { readNativeApi } from "../../nativeApi";
import { refreshProfiles } from "../../profileState";
import { onProviderAccountEvent } from "../../wsNativeApi";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";

type AccountStatus = ProfileSummary["providerAccounts"][number]["status"];

const ANSI_ESCAPE = /\x1b\[[0-9;]*[A-Za-z]/g;
const URL_IN_OUTPUT = /https:\/\/[^\s\x1b<>]+/g;

export function ProviderAccountPanel({
  instanceId,
  status,
  className,
}: {
  readonly instanceId: ProviderInstanceId;
  /**
   * When the caller already knows the account state (the Profiles surface),
   * only the relevant primary action is offered. Omitted on the Providers
   * surface, which shows both.
   */
  readonly status?: AccountStatus;
  readonly className?: string;
}) {
  const finishedHandles = useRef(new Set<string>());
  const [pending, setPending] = useState(false);
  const [handle, setHandle] = useState<string | null>(null);
  const [output, setOutput] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [details, setDetails] = useState("");
  const [outputOpen, setOutputOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const api = readNativeApi()?.profiles;

  useEffect(
    () =>
      onProviderAccountEvent((event) => {
        if (event.instanceId !== instanceId) return;
        if (event.type === "output") setOutput((value) => (value + event.data).slice(-100000));
        else {
          if (event.type === "exited") finishedHandles.current.add(event.handle);
          if (finishedHandles.current.size > 32)
            finishedHandles.current.delete(finishedHandles.current.values().next().value!);
          setHandle((current) => (current === event.handle ? null : current));
          if (event.type === "error") setError(event.data);
          else setOutput((value) => value + `\nAccount setup exited: ${event.data}`);
        }
      }),
    [instanceId],
  );

  // The setup log is the main event while a login is running, and irrelevant
  // once it finishes — but never force it closed if the user opened it.
  useEffect(() => {
    if (handle !== null) setOutputOpen(true);
  }, [handle]);

  if (!api) return null;

  const urls = [...new Set(output.match(URL_IN_OUTPUT) ?? [])];
  const cleanOutput = output.replace(ANSI_ESCAPE, "");
  const outputLines = cleanOutput ? cleanOutput.trimEnd().split("\n").length : 0;
  const isRunning = handle !== null;

  const run = async (operation: () => Promise<unknown>) => {
    setError("");
    setPending(true);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  const showSignIn = status !== "authenticated";
  const showSignOut = status === undefined || status === "authenticated";

  return (
    <div className={cn("space-y-2.5", className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        {showSignIn ? (
          <Button
            size="xs"
            disabled={pending || isRunning}
            onClick={() =>
              void run(async () => {
                setOutput("");
                const result = await api.loginStart({ instanceId });
                setHandle(finishedHandles.current.has(result.handle) ? null : result.handle);
              })
            }
          >
            Sign in
          </Button>
        ) : null}
        {showSignOut ? (
          <Button
            size="xs"
            variant="outline"
            disabled={pending || isRunning}
            onClick={() =>
              void run(async () => {
                setOutput("");
                const result = await api.logout({ instanceId });
                setHandle(finishedHandles.current.has(result.handle) ? null : result.handle);
              })
            }
          >
            Sign out
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          disabled={pending || isRunning}
          onClick={() =>
            void run(async () => {
              const result = await api.accountStatus({ instanceId });
              setDetails(JSON.stringify(result, null, 2));
              // Refresh so the *structured* status badge updates; the raw
              // payload stays behind "Technical details".
              await refreshProfiles().catch(() => {});
              toastManager.add({ type: "success", title: "Account status refreshed" });
            })
          }
        >
          <RotateCwIcon className="size-3" />
          Recheck
        </Button>
        {isRunning ? (
          <Button
            size="xs"
            variant="destructive-outline"
            onClick={() => void run(() => api.cancel({ handle }))}
          >
            Cancel
          </Button>
        ) : null}
      </div>

      {isRunning ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3" />
          Signing in — follow the prompts below.
        </p>
      ) : null}

      {error ? (
        <Alert variant="error" className="text-xs">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {urls.map((url) => (
        <Alert key={url} variant="info" className="text-xs">
          <ExternalLinkIcon />
          <AlertTitle>Finish signing in</AlertTitle>
          <AlertDescription>
            <span className="break-all font-mono text-[11px]">{url}</span>
          </AlertDescription>
          <AlertAction>
            <Button size="xs" render={<a href={url} target="_blank" rel="noreferrer" />}>
              Open
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Copy verification link"
              onClick={() => copyToClipboard(url, undefined)}
            >
              <CopyIcon className="size-3" />
            </Button>
          </AlertAction>
        </Alert>
      ))}

      {cleanOutput ? (
        <Collapsible open={outputOpen} onOpenChange={setOutputOpen}>
          <CollapsibleTrigger
            render={
              <button
                type="button"
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <ChevronDownIcon
                  className={cn("size-3 transition-transform", outputOpen && "rotate-180")}
                />
                Setup output
                {!outputOpen && outputLines > 0 ? (
                  <span className="text-[11px] tabular-nums opacity-70">({outputLines} lines)</span>
                ) : null}
              </button>
            }
          />
          <CollapsibleContent>
            <pre
              aria-label="Account setup output"
              className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-background p-3 text-xs"
            >
              {cleanOutput}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      {isRunning ? (
        <form
          className="grid gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await api.input({ handle, data: input + "\r" });
              setInput("");
            });
          }}
        >
          <span className="text-xs font-medium text-foreground">Reply to the prompt</span>
          <div className="flex gap-2">
            <Input
              aria-label="Account terminal input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
            />
            <Button type="submit" size="sm">
              Send
            </Button>
          </div>
          <span className="text-[11px] text-muted-foreground">
            Sent to the CLI followed by Enter.
          </span>
        </form>
      ) : null}

      {details ? (
        <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
          <CollapsibleTrigger
            render={
              <button
                type="button"
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <ChevronDownIcon
                  className={cn("size-3 transition-transform", detailsOpen && "rotate-180")}
                />
                Technical details
              </button>
            }
          />
          <CollapsibleContent>
            <pre
              aria-label="Account status details"
              className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-background p-3 text-xs"
            >
              {details}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}
