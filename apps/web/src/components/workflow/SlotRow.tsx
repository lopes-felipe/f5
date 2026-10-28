import { ProviderDriverKind } from "@t3tools/contracts";
import { getWorkflowModelCapabilities } from "../../providerModels";
import {
  providerModelOptionsToSelections,
  providerSelectionsToModelOptions,
} from "../../providerModelOptions";
import type {
  ModelCapabilities,
  ServerProvider,
  ModelSlug,
  ProviderKind,
  ProviderModelOptions,
} from "@t3tools/contracts";
import {
  resolveModelCapabilities,
  resolveCodexDispatchModelOptions,
  resolveCodexEffectiveReasoningEffort,
  normalizeClaudeModelOptions,
} from "@t3tools/shared/model";
import { ChevronDownIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";

// Fixed width so the effort column lines up across slot rows ("High" vs "Extra High").
const REASONING_TRIGGER_CLASS_NAME =
  "h-7 w-24 shrink-0 justify-between gap-1 px-2 text-ui text-muted-foreground hover:text-foreground";

function MenuGroupLabel(props: { children: ReactNode }) {
  return (
    <div className="px-2 py-1.5 text-2xs font-medium text-muted-foreground">{props.children}</div>
  );
}

export function WorkflowReasoningPicker(props: {
  disabled?: boolean | undefined;
  provider: ProviderKind;
  model: string;
  capabilities?: ModelCapabilities | null | undefined;
  modelOptions: ProviderModelOptions | undefined;
  onChange: (modelOptions: ProviderModelOptions | undefined) => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  if (props.provider !== "codex" && props.provider !== "claudeAgent") return null;
  const caps = resolveModelCapabilities(props.provider, props.model, props.capabilities);
  const efforts = caps.effortOptions.filter((effort) => effort !== "ultrathink");
  const selections = providerModelOptionsToSelections(props.provider, props.modelOptions) ?? [];
  const selected = (id: string) => selections.find((selection) => selection.id === id)?.value;
  const effortId = props.provider === "codex" ? "reasoningEffort" : "effort";
  const requestedEffort = selected(effortId);
  // Codex shows the effort `turn/start` will run at (an unsupported pick walks down).
  const effort =
    props.provider === "codex"
      ? resolveCodexEffectiveReasoningEffort(
          props.model,
          typeof requestedEffort === "string" ? requestedEffort : undefined,
          props.capabilities,
        )
      : typeof requestedEffort === "string" && efforts.some((effort) => effort === requestedEffort)
        ? requestedEffort
        : (caps.defaultEffort ?? efforts[0]);
  const controls = [
    ...(efforts.length
      ? [
          {
            id: effortId,
            label: "Reasoning",
            value: String(effort ?? efforts[0]),
            options: efforts.map((value) => ({
              value,
              label: value === "xhigh" ? "Extra High" : value[0]!.toUpperCase() + value.slice(1),
            })),
          },
        ]
      : []),
    ...(caps.supportsThinkingToggle
      ? [
          {
            id: "thinking",
            label: "Thinking",
            value: String(selected("thinking") ?? true),
            options: [
              { value: "true", label: "On" },
              { value: "false", label: "Off" },
            ],
          },
        ]
      : []),
    ...(caps.supportsContextWindow
      ? [
          {
            id: "contextWindow",
            label: "Context",
            value: String(selected("contextWindow") ?? "200k"),
            options: [
              { value: "200k", label: "200k" },
              { value: "1m", label: "1M" },
            ],
          },
        ]
      : []),
    ...(caps.supportsFastMode
      ? [
          {
            id: "fastMode",
            label: "Fast Mode",
            value: String(selected("fastMode") ?? false),
            options: [
              { value: "false", label: "Off" },
              { value: "true", label: "On" },
            ],
          },
        ]
      : []),
  ];
  if (!controls.length) return null;
  const first = controls[0]!;
  const label =
    first.id === effortId
      ? first.options.find((option) => option.value === first.value)?.label
      : first.label;
  return (
    <Menu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
      <MenuTrigger
        render={
          <Button
            disabled={props.disabled}
            type="button"
            size="sm"
            variant="ghost"
            className={REASONING_TRIGGER_CLASS_NAME}
          />
        }
      >
        <span className="truncate">{label}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start">
        {controls.map((control) => (
          <MenuGroup key={control.id}>
            <MenuGroupLabel>{control.label}</MenuGroupLabel>
            <MenuRadioGroup
              value={control.value}
              onValueChange={(value) => {
                const next = providerSelectionsToModelOptions(props.provider, [
                  ...selections.filter((selection) => selection.id !== control.id),
                  {
                    id: control.id,
                    value:
                      control.id === "thinking" || control.id === "fastMode"
                        ? value === "true"
                        : value,
                  },
                ]);
                // Codex picks stay explicit: an omitted effort means the default
                // the session reports, which the client may not have seen.
                const normalized =
                  props.provider === "codex"
                    ? resolveCodexDispatchModelOptions(props.model, next?.codex, props.capabilities)
                    : normalizeClaudeModelOptions(
                        props.model,
                        next?.claudeAgent,
                        props.capabilities,
                      );
                props.onChange(normalized ? { [props.provider]: normalized } : undefined);
                setIsMenuOpen(false);
              }}
            >
              {control.options.map((option) => (
                <MenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                  {control.id === effortId && option.value === caps.defaultEffort
                    ? " (default)"
                    : ""}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        ))}
      </MenuPopup>
    </Menu>
  );
}

export function SlotRow(props: {
  disabled?: boolean | undefined;
  label: string;
  provider: ProviderKind;
  model: ModelSlug;
  modelOptions: ProviderModelOptions | undefined;
  providers?: ReadonlyArray<ServerProvider> | undefined;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>;
  onProviderModelChange: (provider: ProviderKind, model: ModelSlug) => void;
  onModelOptionsChange: (modelOptions: ProviderModelOptions | undefined) => void;
  className?: string | undefined;
}) {
  return (
    <div
      data-slot="workflow-slot-row"
      role="group"
      aria-label={props.label}
      className={cn("flex min-w-0 items-center gap-3", props.className)}
    >
      <label className="w-24 shrink-0 truncate text-ui text-muted-foreground" title={props.label}>
        {props.label}
      </label>
      <div className="flex h-9 min-w-0 flex-1 items-center gap-0.5 rounded-lg border border-input bg-background px-1 transition-colors focus-within:border-ring/60">
        <ProviderModelPicker
          providers={props.providers}
          disabled={props.disabled ?? false}
          provider={props.provider}
          model={props.model}
          lockedProvider={null}
          modelOptionsByProvider={props.modelOptionsByProvider}
          onProviderModelChange={props.onProviderModelChange}
          // Fill the field so every row's chevron and effort picker line up.
          triggerClassName="flex-1 max-w-none sm:max-w-none"
        />
        <WorkflowReasoningPicker
          disabled={props.disabled}
          provider={props.provider}
          model={props.model}
          modelOptions={props.modelOptions}
          capabilities={getWorkflowModelCapabilities(
            props.providers ?? [],
            ProviderDriverKind.make(props.provider),
            props.model,
          )}
          onChange={props.onModelOptionsChange}
        />
      </div>
    </div>
  );
}
