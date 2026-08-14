import type { RuntimeMode } from "@t3tools/contracts";
import { LockIcon, LockOpenIcon, PenLineIcon, SparklesIcon, type LucideIcon } from "lucide-react";

export interface RuntimeModePresentation {
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
}

export const RUNTIME_MODE_PRESENTATION: Readonly<Record<RuntimeMode, RuntimeModePresentation>> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before edits and commands.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLineIcon,
  },
  auto: {
    label: "Auto",
    description: "An AI reviewer approves routine actions; risky ones still ask.",
    icon: SparklesIcon,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: LockOpenIcon,
  },
};
