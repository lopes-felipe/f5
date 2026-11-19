import { useState } from "react";
import { ProviderInstanceId, type TextGeneratorConfig } from "@t3tools/contracts";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/select";

const presets = {
  OpenAI: ["openaiCompatible", "https://api.openai.com/v1"],
  OpenRouter: ["openaiCompatible", "https://openrouter.ai/api/v1"],
  Ollama: ["openaiCompatible", "http://localhost:11434/v1"],
  "LM Studio": ["openaiCompatible", "http://localhost:1234/v1"],
  Anthropic: ["anthropic", "https://api.anthropic.com/v1"],
} as const;

export function TextGeneratorsSettings() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const [draft, setDraft] = useState<TextGeneratorConfig>({
    kind: "openaiCompatible",
    label: "OpenAI",
    baseUrl: presets.OpenAI[1],
    apiKey: "",
    enabled: true,
    models: [],
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [modelInput, setModelInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const patch = (value: Partial<TextGeneratorConfig>) =>
    setDraft((current) => ({ ...current, ...value }));
  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      const id = ProviderInstanceId.make(
        editing ?? "textgen_" + crypto.randomUUID().replaceAll("-", ""),
      );
      await updateSettings({ textGenerators: { ...settings.textGenerators, [id]: draft } });
      setEditing(id);
    } catch {
      setError("Could not save the text generator. Check its URL, name, and model IDs.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3 rounded-2xl border border-border p-5">
      <h2 className="text-sm font-medium">Text generators</h2>
      <p className="text-sm text-muted-foreground">
        Model APIs for titles, commit messages, PR text, and text cleanup. They cannot run tools or
        read your workspace.
      </p>
      {Object.entries(settings.textGenerators).map(([id, generator]) => (
        <div key={id} className="flex flex-wrap items-center gap-2">
          <span>
            {generator.label}
            {generator.enabled ? "" : " (disabled)"}
          </span>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              setEditing(id);
              setDraft(generator);
              setModelInput(generator.models.join(", "));
            }}
          >
            Edit
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={!generator.enabled || !generator.models[0]}
            onClick={() =>
              void updateSettings({
                textGenerationModelSelection: {
                  instanceId: ProviderInstanceId.make(id),
                  model: generator.models[0]!,
                },
              })
            }
          >
            Use for text generation
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              const rest = Object.fromEntries(
                Object.entries(settings.textGenerators).filter(([key]) => key !== id),
              );
              void updateSettings({ textGenerators: rest });
              if (editing === id) setEditing(null);
            }}
          >
            Remove
          </Button>
        </div>
      ))}
      <NativeSelect
        aria-label="Text generator preset"
        defaultValue="OpenAI"
        onChange={(event) => {
          const name = event.target.value as keyof typeof presets;
          setEditing(null);
          setModelInput("");
          setDraft({
            kind: presets[name][0],
            label: name,
            baseUrl: presets[name][1],
            apiKey: "",
            enabled: true,
            models: [],
          });
        }}
      >
        {Object.keys(presets).map((name) => (
          <option key={name}>{name}</option>
        ))}
      </NativeSelect>
      <label className="block">
        Name
        <Input
          aria-label="Text generator name"
          value={draft.label}
          onChange={(event) => patch({ label: event.target.value })}
        />
      </label>
      <label className="block">
        Base URL
        <Input
          aria-label="Text generator base URL"
          value={draft.baseUrl}
          onChange={(event) => patch({ baseUrl: event.target.value })}
        />
      </label>
      <label className="block">
        API key
        <Input
          type="password"
          autoComplete="off"
          aria-label="Text generator API key"
          placeholder={draft.apiKeyRedacted ? "Stored key (leave blank to keep)" : ""}
          value={draft.apiKey}
          onChange={(event) => patch({ apiKey: event.target.value })}
        />
      </label>
      <label className="block">
        Model IDs (comma separated)
        <Input
          aria-label="Text generator model IDs"
          value={modelInput}
          onChange={(event) => {
            setModelInput(event.target.value);
            patch({
              models: [
                ...new Set(
                  event.target.value
                    .split(",")
                    .map((model) => model.trim())
                    .filter(Boolean),
                ),
              ],
            });
          }}
        />
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => patch({ enabled: event.target.checked })}
        />
        Enabled
      </label>
      <Button
        size="sm"
        disabled={busy || !draft.label.trim() || !draft.baseUrl.trim() || !draft.models.length}
        onClick={() => void save()}
      >
        {busy ? "Saving…" : editing ? "Save text generator" : "Add text generator"}
      </Button>
      {error && <p role="alert">{error}</p>}
      <label className="block">
        API type
        <NativeSelect
          aria-label="Text generator API type"
          value={draft.kind}
          onChange={(event) => patch({ kind: event.target.value as TextGeneratorConfig["kind"] })}
        >
          <option value="openaiCompatible">OpenAI compatible</option>
          <option value="anthropic">Anthropic</option>
        </NativeSelect>
      </label>
      {editing && (
        <Button
          variant="ghost"
          onClick={() => {
            setEditing(null);
            setDraft({ ...draft, apiKey: "", apiKeyRedacted: false });
          }}
        >
          Add another
        </Button>
      )}
    </section>
  );
}
