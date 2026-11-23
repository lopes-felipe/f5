import { useState } from "react";
import { PlusIcon } from "lucide-react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  ProviderInstanceId,
  type TextGeneratorConfig,
} from "@t3tools/contracts";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsCard } from "./SettingsCard";

const presets = {
  OpenAI: ["openaiCompatible", "https://api.openai.com/v1"],
  OpenRouter: ["openaiCompatible", "https://openrouter.ai/api/v1"],
  Ollama: ["openaiCompatible", "http://localhost:11434/v1"],
  "LM Studio": ["openaiCompatible", "http://localhost:1234/v1"],
  Anthropic: ["anthropic", "https://api.anthropic.com/v1"],
} as const;

type PresetName = keyof typeof presets;

function presetDraft(name: PresetName): TextGeneratorConfig {
  return {
    kind: presets[name][0],
    label: name,
    baseUrl: presets[name][1],
    apiKey: "",
    enabled: true,
    models: [],
  };
}

function parseModels(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  ];
}

type DialogTarget =
  | { readonly mode: "add" }
  | { readonly mode: "edit"; readonly id: ProviderInstanceId };

export function TextGeneratorsSettings() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const [dialogOpen, setDialogOpen] = useState(false);
  // Kept after close so the popup keeps its content during the exit animation.
  const [target, setTarget] = useState<DialogTarget>({ mode: "add" });
  const [dialogSession, setDialogSession] = useState(0);
  const generators = Object.entries(settings.textGenerators);
  const defaultId = settings.textGenerationModelSelection.instanceId;

  const openDialog = (next: DialogTarget) => {
    setTarget(next);
    setDialogSession((session) => session + 1);
    setDialogOpen(true);
  };

  const remove = (id: string) => {
    const rest = Object.fromEntries(
      Object.entries(settings.textGenerators).filter(([key]) => key !== id),
    );
    void updateSettings({
      textGenerators: rest,
      ...(defaultId === id
        ? { textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection }
        : {}),
    });
  };

  const editing = target.mode === "edit" ? settings.textGenerators[target.id] : undefined;
  const editingId = target.mode === "edit" && editing ? target.id : null;

  return (
    <SettingsCard
      title="Text generators"
      description="Model APIs for titles, commit messages, PR text, and text cleanup. They cannot run tools or read your workspace."
      searchTarget="providers.text-generators"
      actions={
        <Button
          size="xs"
          aria-label="Add text generator"
          onClick={() => openDialog({ mode: "add" })}
        >
          <PlusIcon className="size-3" />
          Add
        </Button>
      }
    >
      {generators.length === 0 ? (
        <p className="text-ui text-muted-foreground">
          No text generators yet. Titles and commit messages use the coding agent.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {generators.map(([id, generator]) => {
            const isDefault = defaultId === id;
            return (
              <li
                key={id}
                className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 flex-[1_1_14rem]">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium text-foreground">
                      {generator.label}
                    </p>
                    {isDefault ? (
                      <Badge variant="primary-soft" size="sm">
                        Default
                      </Badge>
                    ) : null}
                  </div>
                  <p className="truncate text-ui text-muted-foreground">
                    {generator.baseUrl} · {generator.models.length}{" "}
                    {generator.models.length === 1 ? "model" : "models"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {isDefault ? null : (
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
                      Use as default
                    </Button>
                  )}
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={`Edit ${generator.label}`}
                    onClick={() => openDialog({ mode: "edit", id: ProviderInstanceId.make(id) })}
                  >
                    Edit
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={`Remove ${generator.label}`}
                    onClick={() => remove(id)}
                  >
                    Remove
                  </Button>
                  <Switch
                    className="ms-1.5"
                    checked={generator.enabled}
                    aria-label={`Enable ${generator.label}`}
                    onCheckedChange={(checked) =>
                      void updateSettings({
                        textGenerators: {
                          ...settings.textGenerators,
                          [id]: { ...generator, enabled: Boolean(checked) },
                        },
                      })
                    }
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogPopup className="max-w-lg">
          <TextGeneratorForm
            key={dialogSession}
            editingId={editingId}
            initial={editing ?? presetDraft("OpenAI")}
            onSave={async (id, config) => {
              await updateSettings({
                textGenerators: { ...settings.textGenerators, [id]: config },
              });
              setDialogOpen(false);
            }}
            onCancel={() => setDialogOpen(false)}
          />
        </DialogPopup>
      </Dialog>
    </SettingsCard>
  );
}

function TextGeneratorForm({
  editingId,
  initial,
  onSave,
  onCancel,
}: {
  readonly editingId: string | null;
  readonly initial: TextGeneratorConfig;
  readonly onSave: (id: ProviderInstanceId, config: TextGeneratorConfig) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState<TextGeneratorConfig>(initial);
  const [modelInput, setModelInput] = useState(initial.models.join(", "));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const models = parseModels(modelInput);
  const patch = (value: Partial<TextGeneratorConfig>) =>
    setDraft((current) => ({ ...current, ...value }));
  const canSave =
    !busy && draft.label.trim() !== "" && draft.baseUrl.trim() !== "" && models.length > 0;

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      const id = ProviderInstanceId.make(
        editingId ?? "textgen_" + crypto.randomUUID().replaceAll("-", ""),
      );
      await onSave(id, { ...draft, models });
    } catch {
      setError("Could not save the text generator. Check its URL, name, and model IDs.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{editingId ? "Edit text generator" : "Add text generator"}</DialogTitle>
        <DialogDescription>
          An OpenAI-compatible or Anthropic API used for titles, commit messages, and PR text.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="grid gap-4">
        {editingId ? null : (
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Preset</span>
            <NativeSelect
              aria-label="Text generator preset"
              defaultValue="OpenAI"
              onChange={(event) => {
                setDraft(presetDraft(event.target.value as PresetName));
                setModelInput("");
              }}
            >
              {Object.keys(presets).map((name) => (
                <option key={name}>{name}</option>
              ))}
            </NativeSelect>
          </label>
        )}
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">API type</span>
          <NativeSelect
            aria-label="Text generator API type"
            value={draft.kind}
            onChange={(event) => patch({ kind: event.target.value as TextGeneratorConfig["kind"] })}
          >
            <option value="openaiCompatible">OpenAI compatible</option>
            <option value="anthropic">Anthropic</option>
          </NativeSelect>
        </label>
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">Name</span>
          <Input
            aria-label="Text generator name"
            value={draft.label}
            onChange={(event) => patch({ label: event.target.value })}
          />
        </label>
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">Base URL</span>
          <Input
            aria-label="Text generator base URL"
            spellCheck={false}
            value={draft.baseUrl}
            onChange={(event) => patch({ baseUrl: event.target.value })}
          />
        </label>
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">API key</span>
          <Input
            type="password"
            autoComplete="off"
            aria-label="Text generator API key"
            placeholder={draft.apiKeyRedacted ? "Stored key, leave blank to keep" : ""}
            value={draft.apiKey}
            onChange={(event) => patch({ apiKey: event.target.value })}
          />
        </label>
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">Model IDs</span>
          <Input
            aria-label="Text generator model IDs"
            spellCheck={false}
            value={modelInput}
            onChange={(event) => setModelInput(event.target.value)}
          />
          <span className="text-2xs text-muted-foreground">
            Comma separated. The first model is used when this generator is the default.
          </span>
        </label>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!canSave} onClick={() => void save()}>
          {busy ? "Saving…" : editingId ? "Save" : "Add"}
        </Button>
      </DialogFooter>
    </>
  );
}
