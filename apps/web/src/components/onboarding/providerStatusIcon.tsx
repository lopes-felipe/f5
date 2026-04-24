import { CheckCircle2Icon, CircleAlertIcon, XCircleIcon, type LucideIcon } from "lucide-react";

export interface ProviderStatusPresentation {
  readonly variant: "ready" | "warning" | "error";
  readonly icon: LucideIcon;
  readonly ariaLabel: string;
}

export function presentProviderStatus(status: {
  readonly status: "ready" | "warning" | "error";
}): ProviderStatusPresentation {
  if (status.status === "ready") {
    return {
      variant: "ready",
      icon: CheckCircle2Icon,
      ariaLabel: "Ready",
    };
  }

  if (status.status === "warning") {
    return {
      variant: "warning",
      icon: CircleAlertIcon,
      ariaLabel: "Warning",
    };
  }

  return {
    variant: "error",
    icon: XCircleIcon,
    ariaLabel: "Error",
  };
}
