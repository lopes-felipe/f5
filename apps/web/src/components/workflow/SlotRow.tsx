import type {
  ClaudeCodeEffort,
  CodexReasoningEffort,
  ModelSlug,
  ProviderKind,
  ProviderModelOptions,
} from "@t3tools/contracts";
import {
  getDefaultReasoningEffort,
  getReasoningEffortOptions,
  normalizeClaudeModelOptions,
  normalizeCodexModelOptions,
  resolveCodexReasoningEffortForModel,
  resolveReasoningEffortForProvider,
  supportsClaudeFastMode,
  supportsClaudeThinkingToggle,
} from "@t3tools/shared/model";
import { ChevronDownIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";

const CODEX_REASONING_LABELS: Record<CodexReasoningEffort, string> = {
  ultra: "Ultra",
  max: "Max",
  xhigh: "Extra High",
  high: "High",
  medium: "Medium",
  low: "Low",
};

const CLAUDE_REASONING_LABELS: Record<Exclude<ClaudeCodeEffort, "ultrathink">, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

// Fixed width so the effort column lines up across slot rows ("High" vs "Extra High").
const REASONING_TRIGGER_CLASS_NAME =
  "h-7 w-24 shrink-0 justify-between gap-1 px-2 text-ui text-muted-foreground hover:text-foreground";

function MenuGroupLabel(props: { children: ReactNode }) {
  return (
    <div className="px-2 py-1.5 text-2xs font-medium text-muted-foreground">{props.children}</div>
  );
}

export function WorkflowReasoningPicker(props: {
  provider: ProviderKind;
  model: string;
  modelOptions: ProviderModelOptions | undefined;
  onChange: (modelOptions: ProviderModelOptions | undefined) => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  if (props.provider === "codex") {
    const options = getReasoningEffortOptions("codex", props.model);
    const defaultEffort = getDefaultReasoningEffort("codex", props.model);
    const selectedEffort = resolveCodexReasoningEffortForModel(
      props.model,
      props.modelOptions?.codex?.reasoningEffort,
    );
    return (
      <Menu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
        <MenuTrigger
          render={
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={REASONING_TRIGGER_CLASS_NAME}
            />
          }
        >
          <span className="truncate">{CODEX_REASONING_LABELS[selectedEffort]}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
        </MenuTrigger>
        <MenuPopup align="start">
          <MenuGroup>
            <MenuGroupLabel>Reasoning</MenuGroupLabel>
            <MenuRadioGroup
              value={selectedEffort}
              onValueChange={(value) => {
                const nextEffort = options.find((option) => option === value);
                if (!nextEffort) return;
                props.onChange({
                  ...props.modelOptions,
                  codex: normalizeCodexModelOptions(props.model, {
                    ...props.modelOptions?.codex,
                    reasoningEffort: nextEffort,
                  }),
                });
                setIsMenuOpen(false);
              }}
            >
              {options.map((option) => (
                <MenuRadioItem key={option} value={option}>
                  {CODEX_REASONING_LABELS[option]}
                  {option === defaultEffort ? " (default)" : ""}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </MenuPopup>
      </Menu>
    );
  }

  if (props.provider !== "claudeAgent") {
    return null;
  }

  const options = getReasoningEffortOptions("claudeAgent", props.model).filter(
    (option): option is Exclude<ClaudeCodeEffort, "ultrathink"> => option !== "ultrathink",
  );
  const supportsThinking = supportsClaudeThinkingToggle(props.model);
  const supportsFast = supportsClaudeFastMode(props.model);
  const defaultEffort = getDefaultReasoningEffort("claudeAgent", props.model);
  const fallbackEffort = options.includes(defaultEffort as Exclude<ClaudeCodeEffort, "ultrathink">)
    ? (defaultEffort as Exclude<ClaudeCodeEffort, "ultrathink">)
    : options[0]!;
  const resolvedEffort = resolveReasoningEffortForProvider(
    "claudeAgent",
    props.modelOptions?.claudeAgent?.effort,
  );
  const selectedEffort: Exclude<ClaudeCodeEffort, "ultrathink"> =
    resolvedEffort && resolvedEffort !== "ultrathink" && options.includes(resolvedEffort)
      ? resolvedEffort
      : fallbackEffort;
  const thinkingEnabled = supportsThinking
    ? (props.modelOptions?.claudeAgent?.thinking ?? true)
    : null;
  const fastModeEnabled = supportsFast && props.modelOptions?.claudeAgent?.fastMode === true;
  const triggerLabel =
    options.length > 0
      ? CLAUDE_REASONING_LABELS[selectedEffort]
      : thinkingEnabled !== null
        ? `Thinking ${thinkingEnabled ? "On" : "Off"}`
        : fastModeEnabled
          ? "Fast"
          : null;
  if (triggerLabel === null) {
    return null;
  }

  return (
    <Menu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
      <MenuTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className={REASONING_TRIGGER_CLASS_NAME}
          />
        }
      >
        <span className="truncate">{triggerLabel}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start">
        {options.length > 0 ? (
          <MenuGroup>
            <MenuGroupLabel>Reasoning</MenuGroupLabel>
            <MenuRadioGroup
              value={selectedEffort}
              onValueChange={(value) => {
                const nextEffort = options.find((option) => option === value);
                if (!nextEffort) return;
                props.onChange({
                  ...props.modelOptions,
                  claudeAgent: normalizeClaudeModelOptions(props.model, {
                    ...props.modelOptions?.claudeAgent,
                    effort: nextEffort,
                  }),
                });
                setIsMenuOpen(false);
              }}
            >
              {options.map((option) => (
                <MenuRadioItem key={option} value={option}>
                  {CLAUDE_REASONING_LABELS[option]}
                  {option === defaultEffort ? " (default)" : ""}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        ) : null}
        {thinkingEnabled !== null ? (
          <MenuGroup>
            <MenuGroupLabel>Thinking</MenuGroupLabel>
            <MenuRadioGroup
              value={thinkingEnabled ? "on" : "off"}
              onValueChange={(value) => {
                props.onChange({
                  ...props.modelOptions,
                  claudeAgent: normalizeClaudeModelOptions(props.model, {
                    ...props.modelOptions?.claudeAgent,
                    thinking: value === "on",
                  }),
                });
                setIsMenuOpen(false);
              }}
            >
              <MenuRadioItem value="on">On (default)</MenuRadioItem>
              <MenuRadioItem value="off">Off</MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        ) : null}
        {supportsFast ? (
          <MenuGroup>
            <MenuGroupLabel>Fast Mode</MenuGroupLabel>
            <MenuRadioGroup
              value={fastModeEnabled ? "on" : "off"}
              onValueChange={(value) => {
                props.onChange({
                  ...props.modelOptions,
                  claudeAgent: normalizeClaudeModelOptions(props.model, {
                    ...props.modelOptions?.claudeAgent,
                    fastMode: value === "on",
                  }),
                });
                setIsMenuOpen(false);
              }}
            >
              <MenuRadioItem value="off">Off</MenuRadioItem>
              <MenuRadioItem value="on">On</MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/**
 * One workflow model slot on a single line: the role on the left, then the
 * provider/model picker and the reasoning picker in one field.
 */
export function SlotRow(props: {
  label: string;
  provider: ProviderKind;
  model: ModelSlug;
  modelOptions: ProviderModelOptions | undefined;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>;
  onProviderModelChange: (provider: ProviderKind, model: ModelSlug) => void;
  onModelOptionsChange: (modelOptions: ProviderModelOptions | undefined) => void;
  className?: string | undefined;
}) {
  return (
    <div
      data-slot="workflow-slot-row"
      className={cn("flex min-w-0 items-center gap-3", props.className)}
    >
      <label className="w-24 shrink-0 truncate text-ui text-muted-foreground" title={props.label}>
        {props.label}
      </label>
      <div className="flex h-9 min-w-0 flex-1 items-center gap-0.5 rounded-lg border border-input bg-background px-1 transition-colors focus-within:border-ring/60">
        <ProviderModelPicker
          provider={props.provider}
          model={props.model}
          lockedProvider={null}
          modelOptionsByProvider={props.modelOptionsByProvider}
          onProviderModelChange={props.onProviderModelChange}
          // Fill the field so every row's chevron and effort picker line up.
          triggerClassName="flex-1 max-w-none sm:max-w-none"
        />
        <WorkflowReasoningPicker
          provider={props.provider}
          model={props.model}
          modelOptions={props.modelOptions}
          onChange={props.onModelOptionsChange}
        />
      </div>
    </div>
  );
}
