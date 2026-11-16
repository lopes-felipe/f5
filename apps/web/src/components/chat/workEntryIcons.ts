import type { CanonicalItemType } from "@t3tools/contracts";
import {
  BotIcon,
  HammerIcon,
  TerminalIcon,
  SquarePenIcon,
  GlobeIcon,
  EyeIcon,
  ImageIcon,
  ClockIcon,
} from "lucide-react";
import { McpIcon } from "../Icons";

export function iconForItemType(type: CanonicalItemType | undefined) {
  switch (type) {
    case "command_execution":
      return TerminalIcon;
    case "file_change":
      return SquarePenIcon;
    case "web_search":
      return GlobeIcon;
    case "image_view":
      return EyeIcon;
    case "image_generation":
      return ImageIcon;
    case "sleep":
      return ClockIcon;
    case "mcp_tool_call":
      return McpIcon;
    case "collab_agent_tool_call":
      return BotIcon;
    default:
      return HammerIcon;
  }
}
