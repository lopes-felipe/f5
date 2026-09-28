import type {
  ProjectIcon as ProjectIconDefinition,
  ProjectIconColor,
  ProjectIconGlyph,
  ProjectId,
} from "@t3tools/contracts";
import {
  BotIcon,
  BriefcaseIcon,
  Code2Icon,
  DatabaseIcon,
  FlaskConicalIcon,
  FolderIcon,
  Gamepad2Icon,
  Globe2Icon,
  RocketIcon,
  TerminalIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { getServerHttpOrigin } from "../lib/serverHttpOrigin";
import { cn } from "../lib/utils";

const ICON_BY_GLYPH: Readonly<Record<ProjectIconGlyph, LucideIcon>> = {
  folder: FolderIcon,
  code: Code2Icon,
  terminal: TerminalIcon,
  bot: BotIcon,
  rocket: RocketIcon,
  flask: FlaskConicalIcon,
  database: DatabaseIcon,
  globe: Globe2Icon,
  briefcase: BriefcaseIcon,
  gamepad: Gamepad2Icon,
};

const COLOR_CLASS_BY_NAME: Readonly<Record<ProjectIconColor, string>> = {
  gray: "text-muted-foreground",
  red: "text-red-500",
  orange: "text-orange-500",
  amber: "text-amber-500",
  green: "text-green-500",
  teal: "text-teal-500",
  blue: "text-blue-500",
  indigo: "text-indigo-500",
  violet: "text-violet-500",
  pink: "text-pink-500",
};

export interface ProjectIconProps {
  readonly projectId: ProjectId;
  readonly name?: string;
  readonly icon?: ProjectIconDefinition | null | undefined;
  readonly className?: string;
}

/** Manual project icon, then checked-in/discovered favicon, then a project monogram. */
export function ProjectIcon({ projectId, name, icon, className }: ProjectIconProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const origin = useMemo(() => getServerHttpOrigin(), []);
  const src = `${origin}/api/project-favicon?projectId=${encodeURIComponent(projectId)}`;

  useEffect(() => setImageFailed(false), [src]);

  if (icon?.type === "emoji") {
    return (
      <span aria-hidden="true" className={cn("inline-flex items-center justify-center", className)}>
        {icon.emoji}
      </span>
    );
  }

  if (icon?.type === "lucide") {
    const Icon = ICON_BY_GLYPH[icon.glyph];
    return <Icon aria-hidden="true" className={cn(COLOR_CLASS_BY_NAME[icon.color], className)} />;
  }

  if (imageFailed || icon?.type === "monogram") {
    const initials =
      icon?.type === "monogram"
        ? icon.text
        : (name ?? "")
            .trim()
            .split(/[\s_/-]+/u)
            .filter(Boolean)
            .slice(0, 2)
            .map((part) => Array.from(part)[0])
            .join("")
            .toLocaleUpperCase();
    return initials ? (
      <span
        aria-hidden="true"
        className={cn(
          "relative isolate inline-flex items-center justify-center rounded-sm text-[0.6em] font-semibold before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:bg-current before:opacity-15",
          COLOR_CLASS_BY_NAME[icon?.type === "monogram" ? icon.color : "blue"],
          className,
        )}
      >
        {initials}
      </span>
    ) : (
      <FolderIcon aria-hidden="true" className={className} />
    );
  }

  return (
    <img
      src={src}
      alt=""
      className={cn("shrink-0 rounded-sm object-contain", className)}
      onError={() => setImageFailed(true)}
    />
  );
}
