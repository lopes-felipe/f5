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
import { fieldShellClassName } from "../ui/input";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";

// Fixed width so the effort column lines up across slot rows ("High" vs "Extra High").
// The selected effort is a value, not a hint, so it gets full contrast.
const REASONING_TRIGGER_CLASS_NAME =
  "h-7 w-24 shrink-0 justify-between gap-1 px-2 text-ui text-foreground";

function MenuGroupLabel(props: { children: ReactNode }) {
  return (
    <div className="px-2 py-1.5 text-2xs font-medium text-muted-foreground">{props.children}</div>
  );
}

type ReasoningControls = NonNullable<ReturnType<typeof buildReasoningControls>>;

/**
 * The reasoning menu's controls for a slot, or `null` when the picker has nothing
 * to show. Single source of truth for both the picker and the divider before it.
 */
function buildReasoningControls(
  provider: ProviderKind,
  model: string,
  capabilities: ModelCapabilities | null | undefined,
  modelOptions: ProviderModelOptions | undefined,
) {
  if (provider !== "codex" && provider !== "claudeAgent") return null;
  const caps = resolveModelCapabilities(provider, model, capabilities);
  const efforts = caps.effortOptions.filter((effort) => effort !== "ultrathink");
  const selections = providerModelOptionsToSelections(provider, modelOptions) ?? [];
  const selected = (id: string) => selections.find((selection) => selection.id === id)?.value;
  const effortId = provider === "codex" ? "reasoningEffort" : "effort";
  const requestedEffort = selected(effortId);
  // Codex shows the effort `turn/start` will run at (an unsupported pick walks down).
  const effort =
    provider === "codex"
      ? resolveCodexEffectiveReasoningEffort(
          model,
          typeof requestedEffort === "string" ? requestedEffort : undefined,
          capabilities,
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
  return { provider, model, capabilities, caps, effortId, selections, controls };
}

export function WorkflowReasoningPicker(props: {
  disabled?: boolean | undefined;
  provider: ProviderKind;
  model: string;
  capabilities?: ModelCapabilities | null | undefined;
  modelOptions: ProviderModelOptions | undefined;
  onChange: (modelOptions: ProviderModelOptions | undefined) => void;
}) {
  const reasoning = buildReasoningControls(
    props.provider,
    props.model,
    props.capabilities,
    props.modelOptions,
  );
  return reasoning ? (
    <ReasoningMenu disabled={props.disabled} reasoning={reasoning} onChange={props.onChange} />
  ) : null;
}

function ReasoningMenu(props: {
  disabled?: boolean | undefined;
  reasoning: ReasoningControls;
  onChange: (modelOptions: ProviderModelOptions | undefined) => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const { provider, model, capabilities, caps, effortId, selections, controls } = props.reasoning;
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
                const next = providerSelectionsToModelOptions(provider, [
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
                  provider === "codex"
                    ? resolveCodexDispatchModelOptions(model, next?.codex, capabilities)
                    : normalizeClaudeModelOptions(model, next?.claudeAgent, capabilities);
                props.onChange(normalized ? { [provider]: normalized } : undefined);
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
  const reasoning = buildReasoningControls(
    props.provider,
    props.model,
    getWorkflowModelCapabilities(
      props.providers ?? [],
      ProviderDriverKind.make(props.provider),
      props.model,
    ),
    props.modelOptions,
  );
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
      <div className={cn(fieldShellClassName, "flex h-9 min-w-0 flex-1 items-center gap-0.5 px-1")}>
        <ProviderModelPicker
          providers={props.providers}
          disabled={props.disabled ?? false}
          provider={props.provider}
          model={props.model}
          lockedProvider={null}
          modelOptionsByProvider={props.modelOptionsByProvider}
          onProviderModelChange={props.onProviderModelChange}
          // Fill the field so every row's chevron and effort picker line up; the
          // selected model is a value, not a hint, so it gets full contrast.
          triggerClassName="flex-1 max-w-none sm:max-w-none text-foreground"
        />
        {reasoning ? (
          <>
            <span
              aria-hidden="true"
              data-slot="workflow-slot-divider"
              className="h-4 w-px shrink-0 bg-border"
            />
            <ReasoningMenu
              disabled={props.disabled}
              reasoning={reasoning}
              onChange={props.onModelOptionsChange}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}
