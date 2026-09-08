import { useEffect, useRef, useState } from "react";
import type { ProviderInstanceId } from "@t3tools/contracts";
import { readNativeApi } from "../../nativeApi";
import { onProviderAccountEvent } from "../../wsNativeApi";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function ProviderAccountPanel({ instanceId }: { instanceId: ProviderInstanceId }) {
  const finishedHandles = useRef(new Set<string>());
  const [pending, setPending] = useState(false);
  const [handle, setHandle] = useState<string | null>(null);
  const [output, setOutput] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
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
  if (!api) return null;
  const urls = [...new Set(output.match(/https:\/\/[^\s\x1b<>]+/g) ?? [])];
  const run = async (operation: () => Promise<unknown>) => {
    setError("");
    setPending(true);
    try {
      await operation();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="space-y-2 text-sm">
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={pending || handle !== null}
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
        <Button
          size="sm"
          disabled={pending || handle !== null}
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
        <Button
          size="sm"
          onClick={() =>
            void run(async () => {
              const status = await api.accountStatus({ instanceId });
              setOutput(JSON.stringify(status, null, 2));
            })
          }
        >
          Check account
        </Button>
        {handle && (
          <Button size="sm" onClick={() => void run(() => api.cancel({ handle }))}>
            Cancel
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {output && (
        <pre
          aria-label="Account setup output"
          className="max-h-64 overflow-auto whitespace-pre-wrap rounded border p-3 text-xs"
        >
          {output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")}
        </pre>
      )}
      {urls.map((url) => (
        <a
          className="block break-all underline"
          key={url}
          href={url}
          target="_blank"
          rel="noreferrer"
        >
          Open verification page
        </a>
      ))}
      {handle && (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await api.input({ handle, data: input + "\r" });
              setInput("");
            });
          }}
        >
          <Input
            aria-label="Account terminal input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
          <Button type="submit">Send</Button>
        </form>
      )}
    </div>
  );
}
